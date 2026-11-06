import { DEDUP_THRESHOLD } from "./budgets.ts";
import type { FingerprintedChunk } from "./types.ts";

interface DedupStats {
  accepted: FingerprintedChunk[];
  skipped: number;
}

export function dedupChunks(chunks: FingerprintedChunk[]): DedupStats {
  const accepted: FingerprintedChunk[] = [];
  const seenFingerprints = new Set<string>();
  let skipped = 0;
  for (const candidate of chunks) {
    if (seenFingerprints.has(candidate.fingerprint)) {
      skipped += 1;
      continue;
    }
    let isDup = false;
    for (const prev of accepted) {
      if (jaccard(candidate.shingles, prev.shingles) >= DEDUP_THRESHOLD) {
        isDup = true;
        break;
      }
    }
    if (isDup) {
      skipped += 1;
      continue;
    }
    seenFingerprints.add(candidate.fingerprint);
    accepted.push(candidate);
  }
  return { accepted, skipped };
}

export function jaccard(a: Set<number>, b: Set<number>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let inter = 0;
  for (const x of small) if (big.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}
