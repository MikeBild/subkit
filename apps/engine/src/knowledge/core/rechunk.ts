import { byteLen, fingerprint, KNOWLEDGE_CHUNK_TARGET_BYTES, splitByBudget } from "./chunking.ts";

export interface StoredChunk {
  title: string | null;
  path: string | null;
  content: string;
}

export interface RechunkedChunk {
  title: string | null;
  path: string | null;
  content: string;
  byte_size: number;
  fingerprint: string;
}

const PART_SUFFIX = / \(part \d+\)$/;

function partBase(title: string | null): string | null {
  if (title === null || !PART_SUFFIX.test(title)) return null;
  return title.replace(PART_SUFFIX, "");
}

export function needsRechunk(
  chunks: readonly Pick<StoredChunk, "content">[],
  budget = KNOWLEDGE_CHUNK_TARGET_BYTES,
): boolean {
  return chunks.some((chunk) => byteLen(chunk.content) > budget);
}

export function rechunk(
  chunks: readonly StoredChunk[],
  budget = KNOWLEDGE_CHUNK_TARGET_BYTES,
): RechunkedChunk[] {
  const groups: Array<{ title: string | null; path: string | null; content: string }> = [];
  let openBase: string | null = null;
  for (const chunk of chunks) {
    const base = partBase(chunk.title);
    const last = groups[groups.length - 1];
    if (base !== null && last && openBase === base && last.path === chunk.path) {
      last.content = `${last.content}\n\n${chunk.content}`;
      continue;
    }
    groups.push({
      title: base !== null ? base || null : chunk.title,
      path: chunk.path,
      content: chunk.content,
    });
    openBase = base;
  }
  const out: RechunkedChunk[] = [];
  for (const group of groups) {
    const pieces = splitByBudget(group.content, budget);
    pieces.forEach((piece, i) => {
      out.push({
        title: pieces.length === 1 ? group.title : `${group.title ?? ""} (part ${i + 1})`,
        path: group.path,
        content: piece,
        byte_size: byteLen(piece),
        fingerprint: fingerprint(piece),
      });
    });
  }
  return out;
}
