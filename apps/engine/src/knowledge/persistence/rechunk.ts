import { and, asc, eq, gt, isNull } from "drizzle-orm";
import {
  type Db,
  dataMigrations,
  type Executor,
  knowledgeChunks,
  knowledgeSources,
} from "../../db/index.ts";
import { rechunk } from "../core/rechunk.ts";
import { insertKnowledgeChunks } from "./chunks.ts";

export async function backfillApplied(db: Executor, name: string): Promise<boolean> {
  const marker = await db
    .select({ name: dataMigrations.name })
    .from(dataMigrations) // tenant-filter:exempt — boot data-migration ledger
    .where(eq(dataMigrations.name, name))
    .limit(1);
  return marker[0] !== undefined;
}

export async function markBackfillApplied(db: Executor, name: string): Promise<void> {
  await db.insert(dataMigrations).values({ name }).onConflictDoNothing();
}

export async function sourcesWithOversizedChunks(
  db: Executor,
  budget: number,
): Promise<Array<{ tenant_id: string; knowledge_source_id: string }>> {
  return await db
    .selectDistinct({
      tenant_id: knowledgeChunks.tenant_id,
      knowledge_source_id: knowledgeChunks.knowledge_source_id,
    })
    .from(knowledgeChunks) // tenant-filter:exempt — boot backfill walks every workspace
    .where(gt(knowledgeChunks.byte_size, budget))
    .orderBy(asc(knowledgeChunks.tenant_id), asc(knowledgeChunks.knowledge_source_id));
}

export async function rechunkSource(
  db: Executor,
  p: { tenant_id: string; knowledge_source_id: string; budget: number },
): Promise<{ before: number; after: number } | null> {
  return await (db as Db).transaction(async (tx) => {
    const [source] = await tx
      .select({ id: knowledgeSources.id })
      .from(knowledgeSources)
      .where(
        and(
          eq(knowledgeSources.tenant_id, p.tenant_id),
          eq(knowledgeSources.id, p.knowledge_source_id),
          isNull(knowledgeSources.deleted_at),
        ),
      )
      .for("update")
      .limit(1);
    if (!source) return null;
    const stored = await tx
      .select({
        title: knowledgeChunks.title,
        path: knowledgeChunks.path,
        content: knowledgeChunks.content,
        byte_size: knowledgeChunks.byte_size,
      })
      .from(knowledgeChunks)
      .where(
        and(
          eq(knowledgeChunks.tenant_id, p.tenant_id),
          eq(knowledgeChunks.knowledge_source_id, p.knowledge_source_id),
        ),
      )
      .orderBy(asc(knowledgeChunks.ordinal));
    if (!stored.some((chunk) => chunk.byte_size > p.budget)) return null;
    const next = rechunk(stored, p.budget);
    await tx
      .delete(knowledgeChunks)
      .where(
        and(
          eq(knowledgeChunks.tenant_id, p.tenant_id),
          eq(knowledgeChunks.knowledge_source_id, p.knowledge_source_id),
        ),
      );
    await insertKnowledgeChunks(tx, p.tenant_id, p.knowledge_source_id, next);
    await tx
      .update(knowledgeSources)
      .set({
        chunk_count: next.length,
        bytes_total: next.reduce((sum, chunk) => sum + chunk.byte_size, 0),
      })
      .where(
        and(
          eq(knowledgeSources.tenant_id, p.tenant_id),
          eq(knowledgeSources.id, p.knowledge_source_id),
        ),
      );
    return { before: stored.length, after: next.length };
  });
}
