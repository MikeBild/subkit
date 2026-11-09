import { dedupChunks as deduplicate } from "../knowledge/core/dedup.ts";
import { DEDUP_THRESHOLD } from "./budgets.ts";
import type { FingerprintedChunk } from "./types.ts";

export { jaccard } from "../knowledge/core/dedup.ts";

export function dedupChunks(chunks: FingerprintedChunk[]) {
  return deduplicate(chunks, DEDUP_THRESHOLD);
}
