import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { and, desc, eq } from "drizzle-orm";
import * as schema from "~/db/schema";
import { bookmarks, courses, lessons, modules, notes } from "~/db/schema";
import { noteBodySchema } from "~/lib/notes";

// ─── Bookmarks and Notes ───
// What a Student attaches to a Lesson for themselves: a Bookmark (a flag) and
// a Note (their own writing). See GLOSSARY.md.
//
// Every function takes the database first, so tests can hand in an in-memory
// one. Every read is scoped to one Student: nothing here returns another
// person's Note, and no Instructor or Platform Admin view may call these with
// someone else's id.
//
// "One per Student per Lesson" is held by unique indexes on both tables; the
// writes below lean on them rather than on a read-then-write check.

export type Db = BetterSQLite3Database<typeof schema>;

/** A Student's place on one Lesson: who, and which Lesson. */
export type StudentLesson = { userId: number; lessonId: number };

function bookmarkOf({ userId, lessonId }: StudentLesson) {
  return and(eq(bookmarks.userId, userId), eq(bookmarks.lessonId, lessonId));
}

function noteOf({ userId, lessonId }: StudentLesson) {
  return and(eq(notes.userId, userId), eq(notes.lessonId, lessonId));
}

export function isBookmarked(db: Db, at: StudentLesson): boolean {
  return !!db
    .select({ id: bookmarks.id })
    .from(bookmarks)
    .where(bookmarkOf(at))
    .get();
}

/**
 * Adds the Bookmark if the Lesson has none, removes it if it has one.
 * Returns whether the Lesson is now bookmarked.
 */
export function toggleBookmark(db: Db, at: StudentLesson, now: Date): boolean {
  const removed = db
    .delete(bookmarks)
    .where(bookmarkOf(at))
    .returning({ id: bookmarks.id })
    .all();
  if (removed.length > 0) return false;

  db.insert(bookmarks)
    .values({ ...at, createdAt: now.toISOString() })
    .onConflictDoNothing()
    .run();
  return true;
}

export type NoteView = { body: string; updatedAt: string };

export function getNote(db: Db, at: StudentLesson): NoteView | null {
  return (
    db
      .select({ body: notes.body, updatedAt: notes.updatedAt })
      .from(notes)
      .where(noteOf(at))
      .get() ?? null
  );
}

export type SaveNoteResult =
  | { ok: true; note: NoteView }
  | { ok: false; error: string };

/**
 * Creates the Student's Note on the Lesson, or replaces its body if they
 * already have one. A re-save moves `updatedAt` on and leaves `createdAt`.
 * The body is trimmed; one over the cap is refused, never truncated.
 */
export function saveNote(
  db: Db,
  at: StudentLesson,
  body: string,
  now: Date
): SaveNoteResult {
  const parsed = noteBodySchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0].message };
  }

  const stamp = now.toISOString();
  const note = db
    .insert(notes)
    .values({ ...at, body: parsed.data, createdAt: stamp, updatedAt: stamp })
    .onConflictDoUpdate({
      target: [notes.userId, notes.lessonId],
      set: { body: parsed.data, updatedAt: stamp },
    })
    .returning({ body: notes.body, updatedAt: notes.updatedAt })
    .get();

  return { ok: true, note };
}

/** The Lesson a saved row points at, and the Course that names it. */
export type SavedLesson = {
  lessonId: number;
  lessonTitle: string;
  courseTitle: string;
  courseSlug: string;
};

const savedLessonColumns = {
  lessonId: lessons.id,
  lessonTitle: lessons.title,
  courseTitle: courses.title,
  courseSlug: courses.slug,
};

/** The Student's Bookmarks, newest first. */
export function listBookmarks(
  db: Db,
  userId: number
): Array<SavedLesson & { createdAt: string }> {
  return db
    .select({ ...savedLessonColumns, createdAt: bookmarks.createdAt })
    .from(bookmarks)
    .innerJoin(lessons, eq(bookmarks.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(bookmarks.userId, userId))
    .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id))
    .all();
}

/** The Student's Notes, most recently edited first. */
export function listNotes(
  db: Db,
  userId: number
): Array<SavedLesson & NoteView> {
  return db
    .select({
      ...savedLessonColumns,
      body: notes.body,
      updatedAt: notes.updatedAt,
    })
    .from(notes)
    .innerJoin(lessons, eq(notes.lessonId, lessons.id))
    .innerJoin(modules, eq(lessons.moduleId, modules.id))
    .innerJoin(courses, eq(modules.courseId, courses.id))
    .where(eq(notes.userId, userId))
    .orderBy(desc(notes.updatedAt), desc(notes.id))
    .all();
}
