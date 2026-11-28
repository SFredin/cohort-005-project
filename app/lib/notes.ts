import { z } from "zod";

// ─── Notes ───
// The rules for a Note body, shared by the Lesson page's form and the
// service that stores it. See GLOSSARY.md: a Note is plain text, private to
// the Student who wrote it, and never rendered as Markdown.

export const MAX_NOTE_LENGTH = 2000;

export const noteBodySchema = z
  .string()
  .trim()
  .min(1, "Write something before saving your note.")
  .max(
    MAX_NOTE_LENGTH,
    `A note can be at most ${MAX_NOTE_LENGTH.toLocaleString("en-US")} characters.`
  );
