// Typed contract for the chat-text file sentinel.
//
// The sentinel `[file:fid_<uuid>]` is the canonical post-rewriter form
// for file references in conversation prose. The chat-text rewriter
// (`conversations/attachments.ts:resolveAttachmentSlugsInText`) replaces
// every `@attachment:<slug>` token with this shape before persistence,
// so every downstream surface — model-message replay, MCP exporters,
// CLI/REPL renderers — sees one normalized representation.
//
// Keep this module tiny. Two contracts live here:
//   1. `FILE_SENTINEL_RE` — the canonical regex; all parsers must use
//      this constant rather than re-deriving the grammar inline.
//   2. The `format` / `extract` / `replace` helpers that own the
//      inverse + traversal. New callers MUST go through one of these
//      so a future grammar change has exactly one home.
//
// The literal sentinel must NEVER reach a human surface (CLI, REPL,
// notification body) or an LLM as raw text. Surfaces that send to the
// LLM strip via `buildUserContentParts`; surfaces that render to humans
// strip via `replaceFileSentinels` to a `[file: <filename>]` placeholder.

/** Canonical regex matching every `[file:fid_<uuid>]` sentinel.
 *  `g` flag — callers using `RegExp.exec` must reset `lastIndex` after
 *  the loop.
 *
 *  Grammar is locked to the strict `fid_<uuid>` shape (lowercase hex
 *  with the 8-4-4-4-12 dash layout) — mirrors `FileIdSchema` in
 *  `api/files-schemas.ts:27`. A loose match (uppercase, dash-stripped,
 *  alphanumeric) would survive to `conversations/persist.ts:94-110`,
 *  where `inArray(fileLinks.file_id, fidUuids)` would either no-row-
 *  match (still safe — the privilege guard holds) or fault at runtime
 *  when the PG driver coerces the malformed UUID. Tightening here
 *  fails the parse early and keeps the downstream chokepoint clean. */
export const FILE_SENTINEL_RE =
  /\[file:(fid_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]/g;

/** Return every fid embedded in `text`, in order, deduplicated.
 *  Empty array if none. */
export function extractFileSentinels(text: string): string[] {
  const out: string[] = [];
  const re = new RegExp(FILE_SENTINEL_RE.source, "g");
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const fid = m[1];
    if (fid && !out.includes(fid)) out.push(fid);
  }
  return out;
}

/** Async-aware replacement helper: walks every sentinel in `text` and
 *  replaces it with the result of `replacer(fid)`. Returns a Promise
 *  when any replacer call returns a Promise; returns a string
 *  synchronously when every call resolves to a string immediately. */
export function replaceFileSentinels(
  text: string,
  replacer: (fid: string) => string | Promise<string>,
): string | Promise<string> {
  const re = new RegExp(FILE_SENTINEL_RE.source, "g");
  const segments: Array<string | Promise<string>> = [];
  let lastIndex = 0;
  let anyAsync = false;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    segments.push(text.slice(lastIndex, m.index));
    const fid = m[1] ?? "";
    const replaced = replacer(fid);
    if (typeof replaced !== "string") anyAsync = true;
    segments.push(replaced);
    lastIndex = m.index + m[0].length;
  }
  segments.push(text.slice(lastIndex));
  if (!anyAsync) return segments.join("");
  return Promise.all(segments).then((parts) => parts.join(""));
}

/** Sync helper for surfaces that render to humans without a fid →
 *  filename lookup in scope (list excerpts, suggestion-loader text).
 *  Replaces every sentinel with the literal `[file]` placeholder so the
 *  raw `fid_<uuid>` never reaches a human or an LLM. Use the async
 *  `replaceFileSentinels` when you can supply a real filename. */
export function stripFileSentinelsForDisplay(text: string): string {
  return text.replace(new RegExp(FILE_SENTINEL_RE.source, "g"), "[file]");
}
