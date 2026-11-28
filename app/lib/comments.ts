export const MIN_COMMENT_LENGTH = 1;
export const MAX_COMMENT_LENGTH = 5000;

const COMMENT_ANCHOR_PREFIX = "comment-";

/** The DOM id the lesson page gives a Comment, whether a Question or a Reply. */
export function commentAnchorId(commentId: number): string {
  return `${COMMENT_ANCHOR_PREFIX}${commentId}`;
}

/** Whether a DOM id is one `commentAnchorId` gives a Comment. */
export function isCommentAnchorId(anchorId: string): boolean {
  if (!anchorId.startsWith(COMMENT_ANCHOR_PREFIX)) return false;
  return /^\d+$/.test(anchorId.slice(COMMENT_ANCHOR_PREFIX.length));
}

/**
 * The URL path that opens a lesson page with one Comment in view. A Comment
 * that is missing from the page leaves the path opening the lesson as usual.
 */
export function commentPath({
  courseSlug,
  lessonId,
  commentId,
}: {
  courseSlug: string;
  lessonId: number;
  commentId: number;
}): string {
  return `/courses/${courseSlug}/lessons/${lessonId}#${commentAnchorId(commentId)}`;
}
