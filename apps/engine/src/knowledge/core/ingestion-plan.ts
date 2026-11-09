import type { FingerprintedChunk } from "../../docs-ingestion/types.ts";
import { dedupChunks } from "./dedup.ts";

export function prepareKnowledgeChunks(
  chunks: readonly FingerprintedChunk[],
  suppliedParsedChunks: boolean,
  threshold: number,
): Readonly<{ accepted: FingerprintedChunk[]; skipped: number; total_bytes: number }> {
  const result = suppliedParsedChunks
    ? { accepted: [...chunks], skipped: 0 }
    : dedupChunks(chunks, threshold);
  return {
    ...result,
    total_bytes: result.accepted.reduce((sum, chunk) => sum + chunk.byte_size, 0),
  };
}
