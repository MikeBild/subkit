// Paste-as-chunk store.
//
// When the user pastes a block of text (or attaches an image via
// `/paste`), we do NOT splice the raw content into the composer — it
// would scroll past the input, break autocomplete placement, and make
// cursor math unreliable. Instead we stash the content and splice a
// one-line placeholder reference into the buffer:
//
//   [Pasted text #3 +42 lines]
//   [Image #2]
//   [File invoice.pdf #4]
//
// Placeholders are stable, deterministic references. On submit, the
// REPL calls `expandRefs(prompt, store)` to substitute text refs
// back inline and emit file / image refs as separate `@`-mentions so
// the existing mention resolver can pick them up.
//
// File-path paste bypasses this local store and stays visible as
// normal composer text. The submit preprocessor uploads existing local
// paths and rewrites them through `@file:fid_...`; `expandRefs` turns
// those mentions into canonical `{"$file":"fid_..."}` leaves.
//
// The paste-ref system keeps the API small and subkit-native.

import { formatFileRef as formatFileLeaf, parseAllFileMentions } from "../utils/file-ref.ts";

export const LARGE_PASTE_CHAR_THRESHOLD = 1000;
export const MAX_USER_INPUT_TEXT_CHARS = 1 << 20;

export type StoredPaste =
  | { id: number; kind: "text"; text: string }
  | {
      id: number;
      kind: "image";
      path: string;
      mediaType: string;
      bytes?: number | undefined;
    }
  | {
      id: number;
      kind: "file";
      path: string;
      filename: string;
      bytes?: number | undefined;
    };

export interface PasteStore {
  addText(text: string): { id: number; ref: string; lines: number };
  addImage(opts: { path: string; mediaType?: string; bytes?: number }): {
    id: number;
    ref: string;
  };
  addFile(opts: { path: string; filename: string; bytes?: number }): {
    id: number;
    ref: string;
  };
  get(id: number): StoredPaste | undefined;
  all(): StoredPaste[];
  delete(id: number): void;
  clear(): void;
}

export function createPasteStore(): PasteStore {
  return new StoreImpl();
}

// ---------- Implementation ----------

const REF_RE = /\[(Pasted text|Image|File [^\]]*?) #(\d+)(?: \+\d+ lines)?\]/g;

class StoreImpl implements PasteStore {
  private nextId = 1;
  private items = new Map<number, StoredPaste>();

  addText(text: string): { id: number; ref: string; lines: number } {
    const id = this.nextId++;
    const lines = countNewlines(text);
    this.items.set(id, { id, kind: "text", text });
    return { id, ref: formatTextRef(id, lines), lines };
  }

  addImage(opts: { path: string; mediaType?: string; bytes?: number }): {
    id: number;
    ref: string;
  } {
    const id = this.nextId++;
    this.items.set(id, {
      id,
      kind: "image",
      path: opts.path,
      mediaType: opts.mediaType ?? "image/png",
      bytes: opts.bytes,
    });
    return { id, ref: formatImageRef(id) };
  }

  addFile(opts: { path: string; filename: string; bytes?: number }): {
    id: number;
    ref: string;
  } {
    const id = this.nextId++;
    this.items.set(id, {
      id,
      kind: "file",
      path: opts.path,
      filename: opts.filename,
      bytes: opts.bytes,
    });
    return { id, ref: formatFileRef(id, opts.filename) };
  }

  get(id: number): StoredPaste | undefined {
    return this.items.get(id);
  }

  all(): StoredPaste[] {
    return [...this.items.values()];
  }

  delete(id: number): void {
    this.items.delete(id);
  }

  clear(): void {
    this.items.clear();
    this.nextId = 1;
  }
}

// ---------- Ref formatting ----------

export function formatTextRef(id: number, lineCount: number): string {
  return lineCount === 0 ? `[Pasted text #${id}]` : `[Pasted text #${id} +${lineCount} lines]`;
}

export function formatImageRef(id: number): string {
  return `[Image #${id}]`;
}

export function formatFileRef(id: number, filename: string): string {
  return `[File ${filename} #${id}]`;
}

function countNewlines(text: string): number {
  const matches = text.match(/\r\n|\r|\n/g);
  return matches ? matches.length : 0;
}

// ---------- Expansion at submit ----------

export interface ExpandedPrompt {
  /** Prompt ready to POST to the engine. Text refs expanded inline. */
  prompt: string;
  /** Files / images that should be attached as `@path` mentions (resolved by `resolveMentions`). */
  attachmentPaths: string[];
  /** Pasted item ids the prompt actually consumed — caller can free these post-submit. */
  consumedIds: number[];
}

/**
 * Replace text refs inline with the original paste content; collect
 * image / file ref paths into `attachmentPaths` so the caller can
 * append them as `@path` mentions before sending the turn.
 *
 * Also recognises `@file:fid_<uuid>` mentions in the composer text
 * and rewrites each occurrence to the canonical JSON file leaf
 * `{"$file":"fid_..."}`. The leaf is spliced inline so downstream
 * prompt parsing sees the wire shape without needing a second
 * resolution pass.
 *
 * Unknown / stale refs are left verbatim — they'll look like
 * `[Pasted text #99]` in the transcript, which is a clear signal the
 * underlying content was already freed.
 */
export function expandRefs(input: string, store: PasteStore): ExpandedPrompt {
  // Engine-backed file mentions are a separate, regex-driven rewrite
  // so they continue to work for resumed conversations whose paste-
  // store has been recreated empty. We process them BEFORE the legacy
  // `[…#N]` refs so an `@file:fid_…` token cannot collide with a
  // stale numbered slot.
  let working = rewriteFileMentions(input);
  const matches = [...working.matchAll(REF_RE)];
  if (matches.length === 0) {
    return { prompt: working, attachmentPaths: [], consumedIds: [] };
  }
  const consumedIds: number[] = [];
  const attachmentPaths: string[] = [];
  // Splice at original match offsets from right to left so earlier
  // offsets stay valid.
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    if (!m || m.index === undefined) continue;
    const id = Number.parseInt(m[2] ?? "0", 10);
    const item = store.get(id);
    if (!item) continue;
    if (item.kind === "text") {
      working = working.slice(0, m.index) + item.text + working.slice(m.index + m[0].length);
      consumedIds.push(id);
    } else {
      // Image / file — leave the ref visible but collect the path so
      // the caller can wire @-mentions.
      attachmentPaths.push(item.path);
      consumedIds.push(id);
    }
  }
  return { prompt: working, attachmentPaths, consumedIds };
}

/** Rewrite every `@file:fid_<uuid>` mention to its canonical JSON
 *  `$file` leaf. Done as a single regex pass so the original
 *  cursor-relative offsets in `expandRefs` stay correct after
 *  substitution. */
function rewriteFileMentions(input: string): string {
  const mentions = parseAllFileMentions(input);
  if (mentions.length === 0) return input;
  let out = input;
  // Replace from right to left so the leftover indices remain valid.
  for (let i = mentions.length - 1; i >= 0; i--) {
    const m = mentions[i];
    if (!m) continue;
    const idx = out.lastIndexOf(m.full);
    if (idx < 0) continue;
    const replacement = JSON.stringify(formatFileLeaf(m.fid));
    out = out.slice(0, idx) + replacement + out.slice(idx + m.full.length);
  }
  return out;
}

/**
 * Decide whether a raw keystroke chunk from stdin should be treated
 * as a large paste placeholder. Smaller bracketed or chunked pastes
 * stay visible in the composer, matching Codex.
 */
export function looksLikePaste(chunk: string): boolean {
  return chunk.length > LARGE_PASTE_CHAR_THRESHOLD;
}
