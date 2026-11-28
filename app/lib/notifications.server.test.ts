import { beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { NotificationKind, RefundStatus, UserRole } from "~/db/schema";
import {
  countUnreadNotifications,
  listNotifications,
  markRefundRequestNotificationsRead,
  notifyQuestionPosted,
  notifyRefundRequestDecided,
  notifyRefundRequestOpened,
  notifySeatClaimed,
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

/** A Team Licence on the base course bought by `teamAdminId`, with its Seats. */
function addTeamLicence(teamAdminId: number, seatCount: number) {
  const team = db.insert(schema.teams).values({}).returning().get();
  const purchase = db
    .insert(schema.purchases)
    .values({
      userId: teamAdminId,
      courseId: base.course.id,
      amountPaid: 7900 * seatCount,
    })
    .returning()
    .get();
  return Array.from({ length: seatCount }, (_, i) =>
    db
      .insert(schema.coupons)
      .values({
        teamId: team.id,
        courseId: base.course.id,
        code: `SEAT-${purchase.id}-${i}`,
        purchaseId: purchase.id,
      })
      .returning()
      .get()
  );
}

/** Marks a Seat claimed by `studentId`, as the redeem action does. */
function claimSeat(seatId: number, studentId: number) {
  db.update(schema.coupons)
    .set({ redeemedByUserId: studentId, redeemedAt: NOW.toISOString() })
    .where(eq(schema.coupons.id, seatId))
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

describe("Seat claimed", () => {
  it("tells the Team Admin who bought the Team Licence who claimed and how many Seats are now claimed", () => {
    const tess = addPerson("Tess", UserRole.Student);
    const ben = addPerson("Ben", UserRole.Student);
    const cara = addPerson("Cara", UserRole.Student);
    const seats = addTeamLicence(tess.id, 10);
    claimSeat(seats[0].id, ben.id);
    claimSeat(seats[1].id, cara.id);
    claimSeat(seats[2].id, base.user.id);

    notifySeatClaimed(db, seats[2].id, NOW);

    expect(listNotifications(db, tess.id, NOW)).toEqual([
      {
        id: expect.any(Number),
        kind: NotificationKind.SeatClaimed,
        sentence: "Test User claimed a Seat on Test Course (3 of 10 claimed)",
        link: "/team",
        createdAt: NOW.toISOString(),
        isUnread: true,
      },
    ]);
  });

  it("gives a Team Admin who claims a Seat on their own Team Licence none", () => {
    const tess = addPerson("Tess", UserRole.Student);
    const seats = addTeamLicence(tess.id, 2);
    claimSeat(seats[0].id, tess.id);

    notifySeatClaimed(db, seats[0].id, NOW);

    expect(listNotifications(db, tess.id, NOW)).toEqual([]);
  });

  it("counts only the Seats of the Team Licence the Seat is on, and tells only its buyer", () => {
    const tess = addPerson("Tess", UserRole.Student);
    const omar = addPerson("Omar", UserRole.Student);
    const ben = addPerson("Ben", UserRole.Student);
    const tessSeats = addTeamLicence(tess.id, 2);
    const omarSeats = addTeamLicence(omar.id, 5);
    claimSeat(omarSeats[0].id, ben.id);
    claimSeat(tessSeats[0].id, base.user.id);

    notifySeatClaimed(db, tessSeats[0].id, NOW);

    expect(
      listNotifications(db, tess.id, NOW).map((notification) => notification.sentence)
    ).toEqual(["Test User claimed a Seat on Test Course (1 of 2 claimed)"]);
    expect(listNotifications(db, omar.id, NOW)).toEqual([]);
    expect(listNotifications(db, base.user.id, NOW)).toEqual([]);
  });
});

/** A lesson on the base course. */
function addLesson(title: string) {
  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();
  return db
    .insert(schema.lessons)
    .values({ moduleId: module.id, title, position: 1 })
    .returning()
    .get();
}

/** A Comment straight into the table: a Reply when `parentId` is given. */
function addComment(lessonId: number, authorId: number, parentId?: number) {
  return db
    .insert(schema.comments)
    .values({ lessonId, userId: authorId, parentId, body: "How does this work?" })
    .returning()
    .get();
}

describe("Question posted", () => {
  it("tells the course's Instructor who asked and on which lesson, linking to the Question", () => {
    const lesson = addLesson("Generics");
    const question = addComment(lesson.id, base.user.id);

    notifyQuestionPosted(db, question.id, NOW);

    expect(listNotifications(db, base.instructor.id, NOW)).toEqual([
      {
        id: expect.any(Number),
        kind: NotificationKind.QuestionPosted,
        sentence: "Test User asked a Question on Generics",
        link: `/courses/test-course/lessons/${lesson.id}#comment-${question.id}`,
        createdAt: NOW.toISOString(),
        isUnread: true,
      },
    ]);
  });

  it("tells nobody but the course's Instructor", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const ines = addPerson("Ines", UserRole.Instructor);
    const lesson = addLesson("Generics");
    const question = addComment(lesson.id, base.user.id);

    notifyQuestionPosted(db, question.id, NOW);

    for (const person of [base.user, pat, ines]) {
      expect(listNotifications(db, person.id, NOW)).toEqual([]);
    }
  });

  it("gives the Instructor none for a top-level Comment of their own", () => {
    const lesson = addLesson("Generics");
    const comment = addComment(lesson.id, base.instructor.id);

    notifyQuestionPosted(db, comment.id, NOW);

    expect(listNotifications(db, base.instructor.id, NOW)).toEqual([]);
  });

  it("gives the Instructor none for a Reply in the thread", () => {
    const ben = addPerson("Ben", UserRole.Student);
    const lesson = addLesson("Generics");
    const question = addComment(lesson.id, base.user.id);
    const reply = addComment(lesson.id, ben.id, question.id);

    notifyQuestionPosted(db, reply.id, NOW);

    expect(listNotifications(db, base.instructor.id, NOW)).toEqual([]);
  });

  it("gives the Instructor none for a Platform Admin's top-level Comment, which is no Question", () => {
    const pat = addPerson("Pat", UserRole.Admin);
    const lesson = addLesson("Generics");
    const comment = addComment(lesson.id, pat.id);

    notifyQuestionPosted(db, comment.id, NOW);

    expect(listNotifications(db, base.instructor.id, NOW)).toEqual([]);
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
