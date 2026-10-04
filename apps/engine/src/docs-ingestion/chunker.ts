import { createHash } from "node:crypto";
import { PER_PAGE_BYTES } from "./budgets.ts";
import type { FingerprintedChunk, RawChunk } from "./types.ts";

export const CHUNK_TARGET_BYTES = 32 * 1024;
export const CHUNK_HARD_BYTES = PER_PAGE_BYTES;

export function canonicalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

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

export function fnv1a32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function fingerprint(text: string): string {
  return createHash("sha256").update(canonicalize(text)).digest("hex").slice(0, 32);
}

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

export function trimToBytes(s: string, cap: number): string {
  if (byteLen(s) <= cap) return s;
  let approx = Math.min(s.length, cap);
  while (approx > 0) {
    const candidate = s.slice(0, approx);
    if (byteLen(candidate) <= cap) return candidate;
    approx -= 1;
  }
  return "";
}
