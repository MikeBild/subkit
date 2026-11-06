import { formatFileRef as formatFileLeaf, parseAllFileMentions } from "../utils/file-ref.ts";

const LARGE_PASTE_CHAR_THRESHOLD = 1000;
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

export interface ExpandedPrompt {
  prompt: string;
  attachmentPaths: string[];
  consumedIds: number[];
}

export function expandRefs(input: string, store: PasteStore): ExpandedPrompt {
  let working = rewriteFileMentions(input);
  const matches = [...working.matchAll(REF_RE)];
  if (matches.length === 0) {
    return { prompt: working, attachmentPaths: [], consumedIds: [] };
  }
  const consumedIds: number[] = [];
  const attachmentPaths: string[] = [];
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
      attachmentPaths.push(item.path);
      consumedIds.push(id);
    }
  }
  return { prompt: working, attachmentPaths, consumedIds };
}

function rewriteFileMentions(input: string): string {
  const mentions = parseAllFileMentions(input);
  if (mentions.length === 0) return input;
  let out = input;
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

export function looksLikePaste(chunk: string): boolean {
  return chunk.length > LARGE_PASTE_CHAR_THRESHOLD;
}
