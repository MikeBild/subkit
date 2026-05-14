// Content-type heuristics shared by every consumer that has to decide
// whether to surface a file's bytes as text or as base64.
//
// The MCP `file://<fid>` resource handler picks between the `text` and
// `blob` shapes of the resource-contents envelope based on this
// predicate. The legacy conversation-attachments route carried its own
// copy at `http/routes/conversation-attachments.ts`; that file will be
// migrated to this helper as part of the Wave-B conversation rewrite
// (Step 6). Keep the predicate identical so the routes wave is a
// straight `import` swap with no behavioural drift.

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
