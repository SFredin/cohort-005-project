import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { NotificationKind, UserRole } from "~/db/schema";
import {
  countUnreadNotifications,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
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

describe("marking one Notification read", () => {
  it("takes it off the Unread count and leaves the person's others Unread", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const ben = addPerson("Ben", UserRole.Student);
    notifyRefundRequestOpened(db, addRefundRequest(base.user.id).id, NOW);
    notifyRefundRequestOpened(db, addRefundRequest(ben.id).id, NOW);
    const [newest] = listNotifications(db, pat.id, NOW);

    expect(markNotificationRead(db, newest.id, pat.id, NOW)).toBe(true);

    expect(countUnreadNotifications(db, pat.id, NOW)).toBe(1);
    expect(
      listNotifications(db, pat.id, NOW).map((notification) => [
        notification.sentence,
        notification.isUnread,
      ])
    ).toEqual([
      ["Refund Request from Ben for Test Course", false],
      ["Refund Request from Test User for Test Course", true],
    ]);
  });
});

describe("marking another person's Notification read", () => {
  it("is refused and leaves it Unread", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const sam = addPerson("Sam", UserRole.Admin);
    notifyRefundRequestOpened(db, addRefundRequest(base.user.id).id, NOW);
    const [pats] = listNotifications(db, pat.id, NOW);

    expect(markNotificationRead(db, pats.id, sam.id, NOW)).toBe(false);

    expect(countUnreadNotifications(db, pat.id, NOW)).toBe(1);
    expect(countUnreadNotifications(db, sam.id, NOW)).toBe(1);
  });

  it("is refused for a Notification that doesn't exist", () => {
    expect(markNotificationRead(db, 999, base.user.id, NOW)).toBe(false);
  });
});

describe("marking all of a person's Notifications read", () => {
  it("clears their Unread count and nobody else's", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const sam = addPerson("Sam", UserRole.Admin);
    const ben = addPerson("Ben", UserRole.Student);
    notifyRefundRequestOpened(db, addRefundRequest(base.user.id).id, NOW);
    notifyRefundRequestOpened(db, addRefundRequest(ben.id).id, NOW);

    markAllNotificationsRead(db, pat.id, NOW);

    expect(countUnreadNotifications(db, pat.id, NOW)).toBe(0);
    expect(
      listNotifications(db, pat.id, NOW).map((notification) => notification.isUnread)
    ).toEqual([false, false]);
    expect(countUnreadNotifications(db, sam.id, NOW)).toBe(2);
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
