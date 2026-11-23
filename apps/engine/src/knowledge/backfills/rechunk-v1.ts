import type { Executor } from "../../db/index.ts";
import { errorFields, logger } from "../../logging/index.ts";
import { KNOWLEDGE_CHUNK_TARGET_BYTES } from "../core/chunking.ts";
import {
  backfillApplied,
  markBackfillApplied,
  rechunkSource,
  sourcesWithOversizedChunks,
} from "../persistence/rechunk.ts";
import { finishKnowledgeWrite } from "../service.ts";

export const KNOWLEDGE_RECHUNK_BACKFILL_NAME = "knowledge_rechunk_v1";

export interface KnowledgeRechunkReport {
  skipped: boolean;
  sources: number;
  rechunked: number;
  failed: number;
}

export async function runKnowledgeRechunkBackfill(
  db: Executor,
  deps: { afterSource?: (tenant_id: string, knowledge_source_id: string) => void } = {},
): Promise<KnowledgeRechunkReport> {
  if (await backfillApplied(db, KNOWLEDGE_RECHUNK_BACKFILL_NAME)) {
    return { skipped: true, sources: 0, rechunked: 0, failed: 0 };
  }
  const afterSource =
    deps.afterSource ??
    ((tenant_id: string, knowledge_source_id: string) =>
      finishKnowledgeWrite(tenant_id, knowledge_source_id, db));
  const sources = await sourcesWithOversizedChunks(db, KNOWLEDGE_CHUNK_TARGET_BYTES);
  let rechunked = 0;
  let failed = 0;
  for (const source of sources) {
    try {
      const result = await rechunkSource(db, { ...source, budget: KNOWLEDGE_CHUNK_TARGET_BYTES });
      if (!result) continue;
      rechunked += 1;
      afterSource(source.tenant_id, source.knowledge_source_id);
    } catch (err) {
      failed += 1;
      logger.error({
        module: "knowledge",
        action: "knowledge.rechunk_backfill.source_failed",
        msg: "re-chunking one knowledge source failed; it is retried on the next boot",
        tenant_id: source.tenant_id,
        knowledge_source_id: source.knowledge_source_id,
        ...errorFields(err),
      });
    }
  }
  if (failed === 0) await markBackfillApplied(db, KNOWLEDGE_RECHUNK_BACKFILL_NAME);
  logger.info({
    module: "knowledge",
    action: "knowledge.rechunk_backfill.completed",
    msg: "knowledge re-chunk backfill finished",
    sources: sources.length,
    rechunked,
    failed,
  });
  return { skipped: false, sources: sources.length, rechunked, failed };
}
