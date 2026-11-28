export const MIN_COMMENT_LENGTH = 1;
export const MAX_COMMENT_LENGTH = 5000;

/** The DOM id the lesson page gives a Comment, whether a Question or a Reply. */
export function commentAnchorId(commentId: number): string {
  return `comment-${commentId}`;
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
