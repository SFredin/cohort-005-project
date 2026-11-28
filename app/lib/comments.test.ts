import { describe, expect, it } from "vitest";
import { commentAnchorId, commentPath } from "./comments";

describe("commentPath", () => {
  it("points at one Comment on its lesson page", () => {
    expect(
      commentPath({
        courseSlug: "intro-to-typescript",
        lessonId: 12,
        commentId: 345,
      })
    ).toBe("/courses/intro-to-typescript/lessons/12#comment-345");
  });

  it("targets the anchor the lesson page gives that Comment", () => {
    const path = commentPath({ courseSlug: "react", lessonId: 1, commentId: 7 });

    expect(new URL(path, "http://cadence.test").hash).toBe(
      `#${commentAnchorId(7)}`
    );
  });
});
