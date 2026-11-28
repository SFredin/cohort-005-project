import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { NotificationKind, RefundStatus, UserRole } from "~/db/schema";
import {
  countUnreadNotifications,
  listNotifications,
  markRefundRequestNotificationsRead,
  notifyRefundRequestDecided,
  notifyRefundRequestOpened,
} from "./notifications.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);
});

function addPerson(name: string, role: UserRole) {
  return db
    .insert(schema.users)
    .values({ name, email: `${name.toLowerCase()}@example.com`, role })
    .returning()
    .get();
}

/** A Refund Request by `buyerId` on the base course, straight into the table. */
function addRefundRequest(buyerId: number) {
  const purchase = db
    .insert(schema.purchases)
    .values({ userId: buyerId, courseId: base.course.id, amountPaid: 7900 })
    .returning()
    .get();
  return db
    .insert(schema.refunds)
    .values({ purchaseId: purchase.id, reason: "Not for me." })
    .returning()
    .get();
}

/** A Platform Admin's decision on a Refund Request, straight into the table. */
function decide(
  refundRequestId: number,
  status: RefundStatus.Approved | RefundStatus.Declined,
  platformAdminId: number
) {
  db.update(schema.refunds)
    .set({
      status,
      resolvedAt: NOW.toISOString(),
      resolvedByUserId: platformAdminId,
    })
    .where(eq(schema.refunds.id, refundRequestId))
    .run();
}

describe("Refund Request opened", () => {
  it("tells every Platform Admin who the buyer is and which course it is for", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const sam = addPerson("Sam", UserRole.Admin);
    const refundRequest = addRefundRequest(base.user.id);

    notifyRefundRequestOpened(db, refundRequest.id, NOW);

    for (const platformAdmin of [pat, sam]) {
      expect(listNotifications(db, platformAdmin.id, NOW)).toEqual([
        {
          id: expect.any(Number),
          kind: NotificationKind.RefundRequestOpened,
          sentence: "Refund Request from Test User for Test Course",
          link: "/admin/refunds",
          createdAt: NOW.toISOString(),
          isUnread: true,
        },
      ]);
    }
  });

  it("tells nobody but Platform Admins", () => {
    addPerson("Pat", UserRole.Admin);
    const refundRequest = addRefundRequest(base.user.id);

    notifyRefundRequestOpened(db, refundRequest.id, NOW);

    expect(listNotifications(db, base.user.id, NOW)).toEqual([]);
    expect(listNotifications(db, base.instructor.id, NOW)).toEqual([]);
  });

  it("gives a buyer who is a Platform Admin none for their own Refund Request", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const sam = addPerson("Sam", UserRole.Admin);
    const refundRequest = addRefundRequest(pat.id);

    notifyRefundRequestOpened(db, refundRequest.id, NOW);

    expect(listNotifications(db, pat.id, NOW)).toEqual([]);
    expect(listNotifications(db, sam.id, NOW)).toHaveLength(1);
  });

  it("keeps the sentence as written when the buyer or course is renamed", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const refundRequest = addRefundRequest(base.user.id);
    notifyRefundRequestOpened(db, refundRequest.id, NOW);

    db.update(schema.users)
      .set({ name: "Renamed" })
      .where(eq(schema.users.id, base.user.id))
      .run();
    db.update(schema.courses)
      .set({ title: "Retitled" })
      .where(eq(schema.courses.id, base.course.id))
      .run();

    expect(
      listNotifications(db, pat.id, NOW).map((notification) => notification.sentence)
    ).toEqual(["Refund Request from Test User for Test Course"]);
  });

  it("rolls back with the caller's transaction", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const refundRequest = addRefundRequest(base.user.id);

    expect(() =>
      db.transaction((tx) => {
        notifyRefundRequestOpened(tx, refundRequest.id, NOW);
        throw new Error("the event failed");
      })
    ).toThrow("the event failed");

    expect(countUnreadNotifications(db, pat.id, NOW)).toBe(0);
  });
});

describe("Refund Request decided", () => {
  it("tells the buyer their Refund Request was approved, linking to the course page", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const refundRequest = addRefundRequest(base.user.id);
    decide(refundRequest.id, RefundStatus.Approved, pat.id);

    notifyRefundRequestDecided(db, refundRequest.id, NOW);

    expect(listNotifications(db, base.user.id, NOW)).toEqual([
      {
        id: expect.any(Number),
        kind: NotificationKind.RefundRequestDecided,
        sentence: "Your Refund Request for Test Course was approved",
        link: "/courses/test-course",
        createdAt: NOW.toISOString(),
        isUnread: true,
      },
    ]);
  });

  it("tells the buyer their Refund Request was declined", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const refundRequest = addRefundRequest(base.user.id);
    decide(refundRequest.id, RefundStatus.Declined, pat.id);

    notifyRefundRequestDecided(db, refundRequest.id, NOW);

    expect(listNotifications(db, base.user.id, NOW)).toMatchObject([
      {
        kind: NotificationKind.RefundRequestDecided,
        sentence: "Your Refund Request for Test Course was declined",
        link: "/courses/test-course",
      },
    ]);
  });

  it("tells nobody but the buyer", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const sam = addPerson("Sam", UserRole.Admin);
    const refundRequest = addRefundRequest(base.user.id);
    decide(refundRequest.id, RefundStatus.Approved, pat.id);

    notifyRefundRequestDecided(db, refundRequest.id, NOW);

    expect(listNotifications(db, pat.id, NOW)).toEqual([]);
    expect(listNotifications(db, sam.id, NOW)).toEqual([]);
    expect(listNotifications(db, base.instructor.id, NOW)).toEqual([]);
  });

  it("gives a Platform Admin who decides their own Refund Request none", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const refundRequest = addRefundRequest(pat.id);
    decide(refundRequest.id, RefundStatus.Declined, pat.id);

    notifyRefundRequestDecided(db, refundRequest.id, NOW);

    expect(listNotifications(db, pat.id, NOW)).toEqual([]);
  });

  it("refuses a Refund Request nobody has decided", () => {
    const refundRequest = addRefundRequest(base.user.id);

    expect(() =>
      notifyRefundRequestDecided(db, refundRequest.id, NOW)
    ).toThrow("has not been decided");
    expect(listNotifications(db, base.user.id, NOW)).toEqual([]);
  });
});

describe("the Unread count", () => {
  it("is zero for a person with no Notifications", () => {
    expect(countUnreadNotifications(db, base.user.id, NOW)).toBe(0);
  });

  it("counts a person's own Unread Notifications and nobody else's", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const sam = addPerson("Sam", UserRole.Admin);
    notifyRefundRequestOpened(db, addRefundRequest(base.user.id).id, NOW);
    notifyRefundRequestOpened(db, addRefundRequest(sam.id).id, NOW);

    expect(countUnreadNotifications(db, pat.id, NOW)).toBe(2);
    expect(countUnreadNotifications(db, sam.id, NOW)).toBe(1);
  });
});

describe("listing Notifications", () => {
  it("puts the newest first", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const ben = addPerson("Ben", UserRole.Student);
    const later = new Date(NOW.getTime() + 60_000);
    notifyRefundRequestOpened(db, addRefundRequest(base.user.id).id, NOW);
    notifyRefundRequestOpened(db, addRefundRequest(ben.id).id, later);

    expect(
      listNotifications(db, pat.id, later).map((notification) => notification.sentence)
    ).toEqual([
      "Refund Request from Ben for Test Course",
      "Refund Request from Test User for Test Course",
    ]);
  });
});

describe("marking a Refund Request's Notifications read", () => {
  it("marks every Platform Admin's copy read and keeps it in their list", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const sam = addPerson("Sam", UserRole.Admin);
    const refundRequest = addRefundRequest(base.user.id);
    notifyRefundRequestOpened(db, refundRequest.id, NOW);

    markRefundRequestNotificationsRead(db, refundRequest.id, NOW);

    for (const platformAdmin of [pat, sam]) {
      expect(countUnreadNotifications(db, platformAdmin.id, NOW)).toBe(0);
      expect(listNotifications(db, platformAdmin.id, NOW)).toMatchObject([
        {
          sentence: "Refund Request from Test User for Test Course",
          isUnread: false,
        },
      ]);
    }
  });

  it("leaves Notifications about other Refund Requests Unread", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const ben = addPerson("Ben", UserRole.Student);
    const decided = addRefundRequest(base.user.id);
    const stillOpen = addRefundRequest(ben.id);
    notifyRefundRequestOpened(db, decided.id, NOW);
    notifyRefundRequestOpened(db, stillOpen.id, NOW);

    markRefundRequestNotificationsRead(db, decided.id, NOW);

    expect(
      listNotifications(db, pat.id, NOW)
        .filter((notification) => notification.isUnread)
        .map((notification) => notification.sentence)
    ).toEqual(["Refund Request from Ben for Test Course"]);
  });

  it("leaves the buyer's Notification about the decision Unread", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const refundRequest = addRefundRequest(base.user.id);
    decide(refundRequest.id, RefundStatus.Approved, pat.id);
    notifyRefundRequestDecided(db, refundRequest.id, NOW);

    markRefundRequestNotificationsRead(db, refundRequest.id, NOW);

    expect(countUnreadNotifications(db, base.user.id, NOW)).toBe(1);
  });
});

describe("deleting what a Notification refers to", () => {
  it("deletes a person's Notifications with the person", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    notifyRefundRequestOpened(db, addRefundRequest(base.user.id).id, NOW);

    db.delete(schema.users).where(eq(schema.users.id, pat.id)).run();

    expect(listNotifications(db, pat.id, NOW)).toEqual([]);
  });

  it("does not cascade from a Refund Request, so one with Notifications can't be deleted", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const refundRequest = addRefundRequest(base.user.id);
    notifyRefundRequestOpened(db, refundRequest.id, NOW);

    expect(() =>
      db
        .delete(schema.refunds)
        .where(eq(schema.refunds.id, refundRequest.id))
        .run()
    ).toThrow(/FOREIGN KEY/);
    expect(listNotifications(db, pat.id, NOW)).toHaveLength(1);
  });
});
