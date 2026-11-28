import { describe, it, expect, beforeEach } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { UserRole } from "~/db/schema";
import {
  getNote,
  isBookmarked,
  listBookmarks,
  listNotes,
  saveNote,
  toggleBookmark,
} from "./bookmarks-and-notes.server";

type TestDb = ReturnType<typeof createTestDb>;

const NOW = new Date(2026, 9, 6, 12, 0, 0);

function minutesLater(minutes: number) {
  return new Date(NOW.getTime() + minutes * 60_000);
}

let db: TestDb;
let base: ReturnType<typeof seedBaseData>;
let lessonIds: number[];

beforeEach(() => {
  db = createTestDb();
  base = seedBaseData(db);

  const module = db
    .insert(schema.modules)
    .values({ courseId: base.course.id, title: "Basics", position: 1 })
    .returning()
    .get();

  lessonIds = [1, 2, 3].map(
    (position) =>
      db
        .insert(schema.lessons)
        .values({ moduleId: module.id, title: `Lesson ${position}`, position })
        .returning()
        .get().id
  );
});

function addStudent(name: string) {
  return db
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase()}@example.com`,
      role: UserRole.Student,
    })
    .returning()
    .get();
}

describe("bookmarking a Lesson", () => {
  it("adds a Bookmark, then removes it on the next toggle", () => {
    const at = { userId: base.user.id, lessonId: lessonIds[0] };

    expect(isBookmarked(db, at)).toBe(false);
    expect(toggleBookmark(db, at, NOW)).toBe(true);
    expect(isBookmarked(db, at)).toBe(true);
    expect(toggleBookmark(db, at, minutesLater(1))).toBe(false);
    expect(isBookmarked(db, at)).toBe(false);
  });

  it("never leaves a Student two Bookmarks on one Lesson", () => {
    const at = { userId: base.user.id, lessonId: lessonIds[0] };

    toggleBookmark(db, at, NOW);
    expect(() =>
      db.insert(schema.bookmarks).values(at).run()
    ).toThrow();
    expect(listBookmarks(db, base.user.id)).toHaveLength(1);
  });
});

describe("saving a Note", () => {
  it("creates the Note with its body trimmed", () => {
    const at = { userId: base.user.id, lessonId: lessonIds[0] };

    const result = saveNote(db, at, "  Rewatch the bit on joins.  ", NOW);

    expect(result).toEqual({
      ok: true,
      note: { body: "Rewatch the bit on joins.", updatedAt: NOW.toISOString() },
    });
    expect(getNote(db, at)).toEqual({
      body: "Rewatch the bit on joins.",
      updatedAt: NOW.toISOString(),
    });
  });

  it("replaces the body and moves the last-edited time on when saved again", () => {
    const at = { userId: base.user.id, lessonId: lessonIds[0] };

    saveNote(db, at, "First thought", NOW);
    saveNote(db, at, "Second thought", minutesLater(5));

    expect(getNote(db, at)).toEqual({
      body: "Second thought",
      updatedAt: minutesLater(5).toISOString(),
    });
    expect(listNotes(db, base.user.id)).toHaveLength(1);
  });

  it("keeps the first created time on a re-save", () => {
    const at = { userId: base.user.id, lessonId: lessonIds[0] };

    saveNote(db, at, "First thought", NOW);
    saveNote(db, at, "Second thought", minutesLater(5));

    const row = db.select().from(schema.notes).get();
    expect(row?.createdAt).toBe(NOW.toISOString());
  });

  it("accepts a Note of exactly 2,000 characters", () => {
    const at = { userId: base.user.id, lessonId: lessonIds[0] };

    const result = saveNote(db, at, "a".repeat(2000), NOW);

    expect(result.ok).toBe(true);
    expect(getNote(db, at)?.body).toHaveLength(2000);
  });

  it("refuses a Note over 2,000 characters and stores nothing", () => {
    const at = { userId: base.user.id, lessonId: lessonIds[0] };

    const result = saveNote(db, at, "a".repeat(2001), NOW);

    expect(result).toEqual({
      ok: false,
      error: "A note can be at most 2,000 characters.",
    });
    expect(getNote(db, at)).toBeNull();
  });

  it("refuses an empty Note", () => {
    const at = { userId: base.user.id, lessonId: lessonIds[0] };

    expect(saveNote(db, at, "   ", NOW).ok).toBe(false);
    expect(getNote(db, at)).toBeNull();
  });

  it("keeps Markdown characters exactly as typed", () => {
    const at = { userId: base.user.id, lessonId: lessonIds[0] };

    saveNote(db, at, "# not a heading\n*not bold*", NOW);

    expect(getNote(db, at)?.body).toBe("# not a heading\n*not bold*");
  });
});

describe("the Saved lists", () => {
  it("list only the Student's own rows, newest first, with Lesson and Course", () => {
    const other = addStudent("Riley");
    const me = base.user.id;

    toggleBookmark(db, { userId: me, lessonId: lessonIds[0] }, NOW);
    toggleBookmark(db, { userId: me, lessonId: lessonIds[2] }, minutesLater(2));
    toggleBookmark(db, { userId: other.id, lessonId: lessonIds[1] }, minutesLater(1));

    saveNote(db, { userId: me, lessonId: lessonIds[1] }, "Older", NOW);
    saveNote(db, { userId: me, lessonId: lessonIds[0] }, "Newer", minutesLater(3));
    saveNote(db, { userId: other.id, lessonId: lessonIds[2] }, "Not mine", minutesLater(4));

    expect(listBookmarks(db, me)).toEqual([
      {
        lessonId: lessonIds[2],
        lessonTitle: "Lesson 3",
        courseTitle: "Test Course",
        courseSlug: "test-course",
        createdAt: minutesLater(2).toISOString(),
      },
      {
        lessonId: lessonIds[0],
        lessonTitle: "Lesson 1",
        courseTitle: "Test Course",
        courseSlug: "test-course",
        createdAt: NOW.toISOString(),
      },
    ]);

    expect(listNotes(db, me)).toEqual([
      {
        lessonId: lessonIds[0],
        lessonTitle: "Lesson 1",
        courseTitle: "Test Course",
        courseSlug: "test-course",
        body: "Newer",
        updatedAt: minutesLater(3).toISOString(),
      },
      {
        lessonId: lessonIds[1],
        lessonTitle: "Lesson 2",
        courseTitle: "Test Course",
        courseSlug: "test-course",
        body: "Older",
        updatedAt: NOW.toISOString(),
      },
    ]);
  });

  it("orders Notes by last edit, so a re-saved Note moves to the top", () => {
    const me = base.user.id;

    saveNote(db, { userId: me, lessonId: lessonIds[0] }, "A", NOW);
    saveNote(db, { userId: me, lessonId: lessonIds[1] }, "B", minutesLater(1));
    saveNote(db, { userId: me, lessonId: lessonIds[0] }, "A again", minutesLater(2));

    expect(listNotes(db, me).map((note) => note.body)).toEqual(["A again", "B"]);
  });
});
