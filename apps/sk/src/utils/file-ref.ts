// Helpers for the `{ "$file": "fid_..." }` reference shape and the
// `@file:fid_...` chat-text mention.
//
// Invariant: the reference shape inside arbitrary JSON values is
// always `{ "$file": "fid_<uuid>" }`. Tool args, workflow inputs,
// audit metadata, conversation snapshot — every surface uses the
// same leaf. In chat text, `@file:fid_...` survives as a short
// mention; the engine rewrites it to `$file` at message-ingest
// time, but the CLI also recognises it so the REPL can resolve it
// client-side before submit.

/** Wire shape for a file reference embedded in arbitrary JSON. */
export interface FileRef {
  $file: string;
}

/** Strict shape — `fid_<uuid>` per `api/files-schemas.ts:FileIdSchema`. */
const FID_RE = /^fid_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Type-guard for `{ $file: "fid_..." }`. Rejects malformed fids
 *  (wrong prefix, wrong UUID shape) so a stray `{$file: "foo"}` does
 *  not confuse downstream resolvers. */
export function isFileRef(v: unknown): v is FileRef {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  const id = obj.$file;
  if (typeof id !== "string") return false;
  return FID_RE.test(id);
}

/** Compose a `FileRef` leaf from a fid. */
export function formatFileRef(fid: string): FileRef {
  return { $file: fid };
}

/** Recognises `@file:fid_<uuid>` inside a larger string. The CLI
 *  inserts this token when the user picks a file via `/files`; the
 *  REPL submitter calls `parseFileMention` per word and swaps each
 *  occurrence with a JSON `$file` leaf in the outgoing payload.
 *
 *  Returns the first match — callers that want all mentions iterate
 *  with `parseAllFileMentions`. */
export function parseFileMention(text: string): { fid: string; full: string } | null {
  const m = text.match(/@file:(fid_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
  if (!m) return null;
  return { fid: m[1] as string, full: m[0] };
}

/** Iterate every `@file:fid_...` mention in `text`. Order is left-to-right. */
export function parseAllFileMentions(text: string): Array<{ fid: string; full: string }> {
  const out: Array<{ fid: string; full: string }> = [];
  const re = /@file:(fid_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/g;
  for (const m of text.matchAll(re)) {
    out.push({ fid: m[1] as string, full: m[0] });
  }
  return out;
}

/** Walk an arbitrary JSON value, calling `visitor` on every `$file`
 *  leaf. Used by `sk executions get` to surface output files and by
 *  the REPL submitter to swap `@file:` mentions on send. The walker
 *  recurses through arrays and plain objects; it does NOT descend
 *  into `{ $file: ... }` (the leaf is terminal). */
export function walkFileRefs(value: unknown, visitor: (ref: FileRef) => void): void {
  if (isFileRef(value)) {
    visitor(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walkFileRefs(item, visitor);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const v of Object.values(value as Record<string, unknown>)) {
      walkFileRefs(v, visitor);
    }
  }
}

/** Collect every fid referenced by `$file` leaves in `value`. */
export function collectFileRefs(value: unknown): string[] {
  const out: string[] = [];
  walkFileRefs(value, (ref) => out.push(ref.$file));
  return out;
}
