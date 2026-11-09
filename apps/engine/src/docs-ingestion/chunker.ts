import {
  byteLen,
  fingerprint,
  shingles,
  splitByBudget,
  trimToBytes,
} from "../knowledge/core/chunking.ts";
import { PER_PAGE_BYTES } from "./budgets.ts";
import type { FingerprintedChunk, RawChunk } from "./types.ts";

export { byteLen, canonicalize, fingerprint, shingles } from "../knowledge/core/chunking.ts";

const CHUNK_TARGET_BYTES = 32 * 1024;
const CHUNK_HARD_BYTES = PER_PAGE_BYTES;

export function fingerprintChunks(
  raw: RawChunk[],
  opts: { onTruncate?: (msg: string) => void; splitBudget?: number } = {},
): FingerprintedChunk[] {
  const out: FingerprintedChunk[] = [];
  for (const r of raw) {
    const pieces = splitByBudget(r.content, opts.splitBudget ?? CHUNK_TARGET_BYTES);
    for (let i = 0; i < pieces.length; i += 1) {
      let piece = pieces[i]!;
      let truncated = false;
      if (byteLen(piece) > CHUNK_HARD_BYTES) {
        piece = trimToBytes(piece, CHUNK_HARD_BYTES);
        truncated = true;
        opts.onTruncate?.(
          `chunk for "${r.title ?? r.path ?? "(unnamed)"}" trimmed to ${CHUNK_HARD_BYTES} bytes`,
        );
      }
      const title = pieces.length === 1 ? (r.title ?? null) : `${r.title ?? ""} (part ${i + 1})`;
      out.push({
        title,
        path: r.path ?? null,
        content: piece,
        byte_size: byteLen(piece),
        fingerprint: fingerprint(piece),
        shingles: shingles(piece),
        truncated,
      });
    }
  }
  return out;
}
