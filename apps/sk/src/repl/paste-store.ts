// Paste-as-chunk store.
//
// When the user pastes a block of text (or attaches an image / doc
// via `/paste` / `/attach`), we do NOT splice the raw content into
// the composer — it would scroll past the input, break autocomplete
// placement, and make cursor math unreliable. Instead we stash the
// content and splice a one-line placeholder reference into the
// buffer:
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
// This mirrors Claude Code's paste-ref system (see history.ts in
// anthropics/claude-code) but keeps the API small and subkit-native.

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
 * Unknown / stale refs are left verbatim — they'll look like
 * `[Pasted text #99]` in the transcript, which is a clear signal the
 * underlying content was already freed.
 */
export function expandRefs(input: string, store: PasteStore): ExpandedPrompt {
  const matches = [...input.matchAll(REF_RE)];
  if (matches.length === 0) {
    return { prompt: input, attachmentPaths: [], consumedIds: [] };
  }
  const consumedIds: number[] = [];
  const attachmentPaths: string[] = [];
  // Splice at original match offsets from right to left so earlier
  // offsets stay valid.
  let out = input;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    if (!m || m.index === undefined) continue;
    const id = Number.parseInt(m[2] ?? "0", 10);
    const item = store.get(id);
    if (!item) continue;
    if (item.kind === "text") {
      out = out.slice(0, m.index) + item.text + out.slice(m.index + m[0].length);
      consumedIds.push(id);
    } else {
      // Image / file — leave the ref visible but collect the path so
      // the caller can wire @-mentions.
      attachmentPaths.push(item.path);
      consumedIds.push(id);
    }
  }
  return { prompt: out, attachmentPaths, consumedIds };
}

/**
 * Decide whether a raw keystroke chunk from stdin should be treated
 * as a paste rather than individual keypresses. Heuristic: chunks of
 * 4+ characters that include at least one newline, OR 16+ characters
 * regardless (long single-line pastes). Matches user intuition — a
 * real human typing a single line can burst up to ~12 chars in an
 * Ink frame window.
 */
export function looksLikePaste(chunk: string): boolean {
  if (chunk.length >= 16) return true;
  if (chunk.length >= 4 && /\r|\n/.test(chunk)) return true;
  return false;
}
