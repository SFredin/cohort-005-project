import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import {
  coupons,
  courses,
  notifications,
  purchases,
  refunds,
  users,
  NotificationKind,
  RefundStatus,
  UserRole,
} from "~/db/schema";

// ─── Notifications ───
// Every read and write of the notifications table. Route actions and the
// refunds module call this; nothing else touches the table. See GLOSSARY.md for
// the language.
//
// Every function takes the database first, so tests can hand in an in-memory
// one, and the current time last. Uses positional parameters (project
// convention).
//
// A Notification's sentence and link are written once, when it is created. It
// is never updated or removed because its subject changed.

type Db = BetterSQLite3Database<typeof schema>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
/** A database or an open transaction on one. */
export type Queryable = Db | Tx;

type NewNotification = {
  recipientId: number;
  kind: NotificationKind;
  sentence: string;
  link: string;
  refundRequestId?: number;
};

/** The one place a Notification is written. Every create function ends here. */
function createNotifications(
  tx: Queryable,
  drafts: NewNotification[],
  now: Date
) {
  if (drafts.length === 0) return;

  tx.insert(notifications)
    .values(drafts.map((draft) => ({ ...draft, createdAt: now.toISOString() })))
    .run();
}

// ─── Create functions: one per event ───
// Each takes the caller's transaction, so the Notification commits or rolls
// back with the event that caused it. The person who did the thing never gets
// one.

/**
 * A buyer raised a Refund Request: tells every Platform Admin but the buyer.
 * Call it in the transaction that inserts the Refund Request.
 */
export function notifyRefundRequestOpened(
  tx: Queryable,
  refundRequestId: number,
  now: Date
) {
  const subject = tx
    .select({
      buyerId: users.id,
      buyerName: users.name,
      courseTitle: courses.title,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(users, eq(purchases.userId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, refundRequestId))
    .get();

  if (!subject) {
    throw new Error(`Refund Request ${refundRequestId} not found.`);
  }

  const platformAdmins = tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.role, UserRole.Admin), ne(users.id, subject.buyerId)))
    .all();

  createNotifications(
    tx,
    platformAdmins.map((platformAdmin) => ({
      recipientId: platformAdmin.id,
      kind: NotificationKind.RefundRequestOpened,
      sentence: `Refund Request from ${subject.buyerName} for ${subject.courseTitle}`,
      link: "/admin/refunds",
      refundRequestId,
    })),
    now
  );
}

/**
 * A Platform Admin approved or declined a Refund Request: tells the buyer.
 * Call it in the decision's transaction, after the decision is recorded.
 */
export function notifyRefundRequestDecided(
  tx: Queryable,
  refundRequestId: number,
  now: Date
) {
  const subject = tx
    .select({
      status: refunds.status,
      deciderId: refunds.resolvedByUserId,
      buyerId: purchases.userId,
      courseTitle: courses.title,
      courseSlug: courses.slug,
    })
    .from(refunds)
    .innerJoin(purchases, eq(refunds.purchaseId, purchases.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(refunds.id, refundRequestId))
    .get();

  if (!subject) {
    throw new Error(`Refund Request ${refundRequestId} not found.`);
  }
  if (subject.status === RefundStatus.Open) {
    throw new Error(`Refund Request ${refundRequestId} has not been decided.`);
  }

  // A Platform Admin who decides their own Refund Request already knows.
  if (subject.deciderId === subject.buyerId) return;

  const outcome =
    subject.status === RefundStatus.Approved ? "approved" : "declined";

  createNotifications(
    tx,
    [
      {
        recipientId: subject.buyerId,
        kind: NotificationKind.RefundRequestDecided,
        sentence: `Your Refund Request for ${subject.courseTitle} was ${outcome}`,
        link: `/courses/${subject.courseSlug}`,
      },
    ],
    now
  );
}

/**
 * A Student claimed a Seat: tells the Team Admin who bought its Team Licence,
 * unless that Team Admin is the one who claimed it.
 * Call it in the transaction that claims the Seat, after the claim is written,
 * so the count includes it.
 */
export function notifySeatClaimed(tx: Queryable, seatId: number, now: Date) {
  const subject = tx
    .select({
      teamLicenceId: purchases.id,
      teamAdminId: purchases.userId,
      studentId: users.id,
      studentName: users.name,
      courseTitle: courses.title,
    })
    .from(coupons)
    .innerJoin(purchases, eq(coupons.purchaseId, purchases.id))
    .innerJoin(users, eq(coupons.redeemedByUserId, users.id))
    .innerJoin(courses, eq(purchases.courseId, courses.id))
    .where(eq(coupons.id, seatId))
    .get();

  if (!subject) {
    throw new Error(`Claimed Seat ${seatId} not found.`);
  }
  if (subject.studentId === subject.teamAdminId) return;

  const seats = tx
    .select({
      total: sql<number>`count(*)`,
      claimed: sql<number>`count(${coupons.redeemedAt})`,
    })
    .from(coupons)
    .where(eq(coupons.purchaseId, subject.teamLicenceId))
    .get();

  createNotifications(
    tx,
    [
      {
        recipientId: subject.teamAdminId,
        kind: NotificationKind.SeatClaimed,
        sentence: `${subject.studentName} claimed a Seat on ${subject.courseTitle} (${seats?.claimed ?? 0} of ${seats?.total ?? 0} claimed)`,
        link: "/team",
      },
    ],
    now
  );
}

// ─── Reading ───

export type NotificationForRecipient = {
  id: number;
  kind: NotificationKind;
  sentence: string;
  link: string;
  createdAt: string;
  isUnread: boolean;
};

/**
 * Which of a person's Notifications they can still see. `now` is here for the
 * 90-day limit, which nothing applies yet.
 */
function visibleTo(recipientId: number, _now: Date) {
  return eq(notifications.recipientId, recipientId);
}

/** A person's Notifications, read and Unread together, newest first. */
export function listNotifications(
  db: Queryable,
  recipientId: number,
  now: Date
): NotificationForRecipient[] {
  return db
    .select()
    .from(notifications)
    .where(visibleTo(recipientId, now))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .all()
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      sentence: row.sentence,
      link: row.link,
      createdAt: row.createdAt,
      isUnread: row.readAt === null,
    }));
}

/** How many of a person's Notifications are Unread: the number on the bell. */
export function countUnreadNotifications(
  db: Queryable,
  recipientId: number,
  now: Date
): number {
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(notifications)
    .where(and(visibleTo(recipientId, now), isNull(notifications.readAt)))
    .get();

  return result?.count ?? 0;
}

// ─── Marking read ───
// Read is set once and never cleared, so each of these only touches Unread
// Notifications.

/**
 * Marks read every Notification that references a Refund Request: each Platform
 * Admin's "Refund Request opened", the decider's own included. They stay in
 * each list as a record. Call it in the decision's transaction.
 */
export function markRefundRequestNotificationsRead(
  tx: Queryable,
  refundRequestId: number,
  now: Date
) {
  tx.update(notifications)
    .set({ readAt: now.toISOString() })
    .where(
      and(
        eq(notifications.refundRequestId, refundRequestId),
        isNull(notifications.readAt)
      )
    )
    .run();
}
