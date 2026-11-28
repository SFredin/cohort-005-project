import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "~/db/schema";
import { commentPath } from "~/lib/comments";
import {
  comments,
  courses,
  lessons,
  modules,
  notifications,
  purchases,
  refunds,
  users,
  NotificationKind,
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
 * A Student posted a Question: tells the course's Instructor. Call it in the
 * transaction that inserts the Comment. A Comment that is not a Question
 * creates nothing.
 */
export function notifyQuestionPosted(
  tx: Queryable,
  commentId: number,
  now: Date
) {
  const subject = tx
    .select({
      authorId: users.id,
      authorName: users.name,
      authorRole: users.role,
      parentId: comments.parentId,
      lessonId: lessons.id,
      lessonTitle: lessons.title,
      courseSlug: courses.slug,
      instructorId: courses.instructorId,
    })
    .from(comments)
    .innerJoin(users, eq(comments.userId, users.id))
    .innerJoin(lessons, eq(comments.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(comments.id, commentId))
    .get();

  if (!subject) {
    throw new Error(`Comment ${commentId} not found.`);
  }

  // Only a Question tells the Instructor: later Replies in its thread don't,
  // and neither does a top-level Comment by the Instructor or a Platform Admin.
  const isQuestion =
    subject.parentId === null &&
    subject.authorId !== subject.instructorId &&
    subject.authorRole !== UserRole.Admin;
  if (!isQuestion) return;

  createNotifications(
    tx,
    [
      {
        recipientId: subject.instructorId,
        kind: NotificationKind.QuestionPosted,
        sentence: `${subject.authorName} asked a Question on ${subject.lessonTitle}`,
        link: commentPath({
          courseSlug: subject.courseSlug,
          lessonId: subject.lessonId,
          commentId,
        }),
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
