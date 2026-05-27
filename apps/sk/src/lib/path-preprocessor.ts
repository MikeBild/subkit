// Auto-uploads local filesystem paths that appear in natural-language
// chat prompts so the user never has to copy the bytes by hand. When a
// user submits "create a knowledge source from /Users/.../foo.md", the
// preprocessor extracts the path, uploads it via the same chokepoint
// `/attach` uses, links the file to the active conversation, and
// splices an `@file:fid_…` mention in place of the raw path. The
// existing `expandRefs` rewrite turns that mention into the canonical
// `{"$file":"fid_…"}` leaf at submit time — so the agent receives a
// normal attachment ref and can call `create_knowledge_source` with
// `mode='from_attachment'` directly.
//
// The architectural premise is: the engine cannot read the operator's
// local filesystem, but `sk` runs on the operator's machine and can.
// Closing this gap here removes the agent's need to bounce users to a
// slash command they then have to copy-paste — a UX failure that no
// amount of slash-command hardening fixes.

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { uploadPath } from "../commands/files.ts";
import type { EngineClient } from "../engine-client.ts";
import { sanitizePathInput } from "./path-input.ts";

export interface PathCandidate {
  /** Exact substring as it appears in the input, including surrounding
   *  trailing punctuation that the trim removed. */
  raw: string;
  /** Sanitized + trimmed path used for filesystem lookup. */
  cleaned: string;
  /** Inclusive byte offset of `raw` in the original input. */
  start: number;
  /** Exclusive byte offset of `raw` end in the original input. */
  end: number;
}

export interface UploadedPath {
  raw: string;
  fid: string;
  filename: string;
  bytes: number;
}

export interface SkippedPath {
  raw: string;
  reason: "not_found" | "not_file" | "upload_failed";
  detail?: string;
}

export interface AutoUploadResult {
  rewritten: string;
  uploaded: UploadedPath[];
  skipped: SkippedPath[];
}

// Path-shaped tokens. Anchored at a non-path char on the left (start
// of string OR whitespace), then `~/`, `./`, `../`, or `/`, then a run
// of non-whitespace, non-quote, non-bracket chars. Brackets and quotes
// are excluded so paths embedded in markdown links `[name](/p)` or
// quoted args `"/p"` extract cleanly.
const PATH_RE = /(?:^|(?<=\s))(?:~\/|\.{1,2}\/|\/)[^\s"'<>`(){}[\]]+/g;

// Trailing characters to strip when they sit after an alphanumeric —
// markdown renderers love attaching these to paths in prose.
const TRAILING_PUNCT_RE = /[.,;:!?)\]>]+$/;

export function extractCandidatePaths(input: string): PathCandidate[] {
  const out: PathCandidate[] = [];
  for (const m of input.matchAll(PATH_RE)) {
    if (m.index === undefined) continue;
    const raw = m[0];
    // Strip trailing punct only if the preceding char is alphanumeric.
    // Keeps "/tmp/x.md" (ends in 'd') trimming "/tmp/x.md," correctly,
    // and leaves "/tmp/foo." (a literal path ending in dot, rare) as
    // existsSync's problem.
    let cleaned = sanitizePathInput(raw);
    const trail = cleaned.match(TRAILING_PUNCT_RE);
    if (trail && trail.index !== undefined && trail.index > 0) {
      const beforePunct = cleaned[trail.index - 1] ?? "";
      if (/[A-Za-z0-9]/.test(beforePunct)) {
        cleaned = cleaned.slice(0, trail.index);
      }
    }
    out.push({
      raw,
      cleaned,
      start: m.index,
      end: m.index + raw.length,
    });
  }
  return out;
}

function resolveCandidate(cwd: string, cleaned: string): string {
  if (cleaned.startsWith("~/")) {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    return resolve(home, cleaned.slice(2));
  }
  return resolve(cwd, cleaned);
}

export async function autoUploadLocalPaths(
  input: string,
  client: EngineClient,
  cwd: string,
  conversationId: string | null | undefined,
): Promise<AutoUploadResult> {
  const candidates = extractCandidatePaths(input);
  if (candidates.length === 0) {
    return { rewritten: input, uploaded: [], skipped: [] };
  }

  const uploaded: UploadedPath[] = [];
  const skipped: SkippedPath[] = [];
  // Map of `start` offset → replacement text, applied right-to-left so
  // earlier offsets stay valid.
  const replacements: Array<{ start: number; end: number; with: string }> = [];

  for (const c of candidates) {
    const abs = resolveCandidate(cwd, c.cleaned);
    if (!existsSync(abs)) {
      skipped.push({ raw: c.raw, reason: "not_found" });
      continue;
    }
    const st = statSync(abs);
    if (!st.isFile()) {
      skipped.push({ raw: c.raw, reason: "not_file" });
      continue;
    }
    try {
      const row = await uploadPath(client, abs, { quiet: true });
      uploaded.push({
        raw: c.raw,
        fid: row.id,
        filename: row.filename,
        bytes: st.size,
      });
      if (conversationId) {
        // Best-effort link so `/files` and the agent's
        // `list_attachments` surface it. Failure here doesn't block
        // submit — the `$file` leaf still resolves on the engine.
        try {
          await client.linkFile(row.id, {
            resource_type: "conversation",
            resource_id: conversationId,
            role: "attachment",
          });
        } catch {
          /* link is best-effort */
        }
      }
      replacements.push({
        start: c.start,
        end: c.end,
        // The `@file:fid_…` mention is rewritten by `expandRefs` →
        // `rewriteFileMentions` to the canonical `{"$file":"fid_…"}`
        // leaf at submit. Keeping the mention shape here means the
        // user sees a readable token in the optimistic echo and the
        // wire payload matches `/attach`-inserted leaves byte-for-byte.
        with: `@file:${row.id}`,
      });
    } catch (err) {
      skipped.push({
        raw: c.raw,
        reason: "upload_failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (replacements.length === 0) {
    return { rewritten: input, uploaded, skipped };
  }

  let rewritten = input;
  replacements.sort((a, b) => b.start - a.start);
  for (const r of replacements) {
    rewritten = rewritten.slice(0, r.start) + r.with + rewritten.slice(r.end);
  }
  return { rewritten, uploaded, skipped };
}
