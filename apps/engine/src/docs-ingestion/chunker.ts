// Chunker: takes raw `(title, content)` pairs from a source and splits
// them into byte-bounded chunks with stable fingerprints.
//
// Why not `TextEncoder.encode().length` everywhere? For ASCII-dominant
// openapi + markdown docs the string length is a good-enough upper bound
// for byte size, and we sanity-check with `Buffer.byteLength(..., 'utf8')`
// at the split points. This keeps the hot loop cheap.

import { createHash } from "node:crypto";

import { PER_PAGE_BYTES } from "./budgets.ts";
import type { FingerprintedChunk, RawChunk } from "./types.ts";

/** Target body size per chunk — well under the 3 MB per-page cap. */
export const CHUNK_TARGET_BYTES = 32 * 1024; // 32 KiB — friendly for LLMs
/** Absolute max a single chunk may occupy after splitting. */
export const CHUNK_HARD_BYTES = PER_PAGE_BYTES;

/**
 * Normalizes content for fingerprinting: lowercase, collapse whitespace,
 * strip leading/trailing space. This is ONLY used for the dedup signal —
 * the stored chunk keeps its original formatting.
 */
export function canonicalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * 5-gram word shingles over the canonicalized text. Returns a Set of 32-bit
 * hashes so Jaccard similarity is a set-intersection count. We avoid a real
 * xxhash dep — FNV-1a is fine for a dedup signal.
 */
export function shingles(text: string, n = 5): Set<number> {
  const canon = canonicalize(text);
  const words = canon.split(" ").filter(Boolean);
  const out = new Set<number>();
  if (words.length === 0) return out;
  if (words.length < n) {
    out.add(fnv1a32(words.join(" ")));
    return out;
  }
  for (let i = 0; i <= words.length - n; i += 1) {
    out.add(fnv1a32(words.slice(i, i + n).join(" ")));
  }
  return out;
}

/** 32-bit FNV-1a. Plenty of entropy for a shingle hash. */
export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable per-chunk fingerprint — SHA-256 of the canonical body. */
export function fingerprint(text: string): string {
  return createHash("sha256").update(canonicalize(text)).digest("hex").slice(0, 32);
}

/**
 * Split a long content body into pieces that each fit the chunk budget.
 * Splits on paragraph boundaries first, then on sentence, then hard slice.
 */
export function splitByBudget(text: string, budget = CHUNK_TARGET_BYTES): string[] {
  if (byteLen(text) <= budget) return [text];
  const out: string[] = [];
  const paragraphs = text.split(/\n{2,}/);
  let buf = "";
  const flush = () => {
    if (buf.length) out.push(buf);
    buf = "";
  };
  for (const p of paragraphs) {
    if (byteLen(p) > budget) {
      flush();
      // Further split the oversized paragraph.
      const subs = splitParagraph(p, budget);
      for (const s of subs) {
        if (byteLen(buf) + byteLen(s) + 2 > budget) flush();
        buf = buf ? `${buf}\n\n${s}` : s;
      }
      continue;
    }
    if (byteLen(buf) + byteLen(p) + 2 > budget) flush();
    buf = buf ? `${buf}\n\n${p}` : p;
  }
  flush();
  return out;
}

function splitParagraph(p: string, budget: number): string[] {
  const sentences = p.split(/(?<=[.!?])\s+/);
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.length) out.push(buf);
    buf = "";
  };
  for (const s of sentences) {
    if (byteLen(s) > budget) {
      flush();
      // Final resort: hard-slice long atoms.
      for (let i = 0; i < s.length; i += budget) out.push(s.slice(i, i + budget));
      continue;
    }
    if (byteLen(buf) + byteLen(s) + 1 > budget) flush();
    buf = buf ? `${buf} ${s}` : s;
  }
  flush();
  return out;
}

export function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Take a list of raw chunks, split each by byte budget, and attach
 * fingerprints. Every returned chunk satisfies
 * `byte_size <= CHUNK_HARD_BYTES`. If a single piece would exceed the
 * 3 MB per-page cap we truncate it (preserving a UTF-8 boundary) and
 * mark `truncated: true` on the chunk so the orchestrator can raise a
 * budget warning.
 */
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

/**
 * Trim a UTF-8 string so its byte length is <= cap. We slice in
 * code-units and back off if we end mid-codepoint.
 */
export function trimToBytes(s: string, cap: number): string {
  if (byteLen(s) <= cap) return s;
  // Conservative upper bound — every codepoint is ≤ 4 bytes in UTF-8.
  let approx = Math.min(s.length, cap);
  while (approx > 0) {
    const candidate = s.slice(0, approx);
    if (byteLen(candidate) <= cap) return candidate;
    approx -= 1;
  }
  return "";
}
