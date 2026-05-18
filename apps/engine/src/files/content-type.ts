// Content-type heuristics shared by every consumer that has to decide
// whether to surface a file's bytes as text or as base64.
//
// The MCP `file://<fid>` resource handler picks between the `text` and
// `blob` shapes of the resource-contents envelope based on this
// predicate. The conversation-attachments route imports the same
// helper so the predicate is identical across every surface that
// renders a file's bytes — keep new branches additive so the routes
// stay in lock-step.

/** Returns true when the MIME type is safely representable as a UTF-8
 *  text body. The heuristic is intentionally lenient: empty / unknown
 *  content types default to true so a file with no `Content-Type`
 *  header still surfaces through the text branch instead of being
 *  base64-wrapped. Binary callers should always set an explicit
 *  `content_type` at upload time. */
export function isTextLike(content_type: string | null | undefined): boolean {
  if (!content_type) return true;
  return (
    content_type.startsWith("text/") ||
    content_type.includes("json") ||
    content_type.includes("yaml") ||
    content_type.includes("xml") ||
    content_type.includes("x-www-form-urlencoded")
  );
}
