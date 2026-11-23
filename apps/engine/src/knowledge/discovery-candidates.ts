import { and, eq } from "drizzle-orm";
import type { Actor } from "../audit/actor.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Executor } from "../db/client.ts";
import { knowledgeChunks, knowledgeSources } from "../db/schema/knowledge_sources.ts";
import { insertKnowledgeChunks } from "./persistence/chunks.ts";
import { type KnowledgeVersionContent, recordKnowledgeVersion } from "./version-record.ts";

type KnowledgeSourceRow = typeof knowledgeSources.$inferSelect;
type KnowledgeChunkRow = typeof knowledgeChunks.$inferSelect;

export async function findKnowledgeSourceRow(
  db: Executor,
  tenant_id: string,
  knowledge_source_id: string,
): Promise<KnowledgeSourceRow | undefined> {
  const rows = await db
    .select()
    .from(knowledgeSources)
    .where(
      and(eq(knowledgeSources.tenant_id, tenant_id), eq(knowledgeSources.id, knowledge_source_id)),
    )
    .limit(1);
  return rows[0];
}

export async function listKnowledgeChunkRows(
  db: Executor,
  tenant_id: string,
  knowledge_source_id: string,
): Promise<KnowledgeChunkRow[]> {
  return db
    .select()
    .from(knowledgeChunks)
    .where(
      and(
        eq(knowledgeChunks.tenant_id, tenant_id),
        eq(knowledgeChunks.knowledge_source_id, knowledge_source_id),
      ),
    );
}

export async function findKnowledgeSourceBySlug(
  db: Executor,
  tenant_id: string,
  slug: string,
): Promise<KnowledgeSourceRow | undefined> {
  const rows = await db
    .select()
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.tenant_id, tenant_id), eq(knowledgeSources.slug, slug)))
    .limit(1);
  return rows[0];
}

export async function findFirstKnowledgeChunk(
  db: Executor,
  tenant_id: string,
  knowledge_source_id: string,
): Promise<KnowledgeChunkRow | undefined> {
  const chunks = await db
    .select()
    .from(knowledgeChunks)
    .where(
      and(
        eq(knowledgeChunks.tenant_id, tenant_id),
        eq(knowledgeChunks.knowledge_source_id, knowledge_source_id),
      ),
    )
    .limit(1);
  return chunks[0];
}

interface SingleChunkSourceWrite {
  readonly tenant_id: string;
  readonly slug: string;
  readonly source_type: string;
  readonly source_uri: string;
  readonly name: string;
  readonly description: string;
  readonly chunk_title: string;
  readonly json: string;
  readonly version: string;
  readonly bytes: number;
  readonly now: Date;
  readonly content: KnowledgeVersionContent;
  readonly actor: Actor | null;
}

export async function upsertSingleChunkKnowledgeSource(
  db: Executor,
  p: SingleChunkSourceWrite,
): Promise<{ row_id: string; cached_at: string; created: boolean }> {
  return db.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, p.tenant_id);
    const existing = await tx
      .select()
      .from(knowledgeSources)
      .where(and(eq(knowledgeSources.tenant_id, p.tenant_id), eq(knowledgeSources.slug, p.slug)))
      .limit(1);
    const prior = existing[0];

    if (prior) {
      await tx
        .update(knowledgeSources)
        .set({
          source_type: p.source_type,
          source_uri: p.source_uri,
          version: p.version,
          bytes_total: p.bytes,
          chunk_count: 1,
          last_refreshed_at: p.now,
          status: "active",
          updated_at: p.now,
        })
        .where(eq(knowledgeSources.id, prior.id));
      await tx
        .delete(knowledgeChunks)
        .where(
          and(
            eq(knowledgeChunks.tenant_id, p.tenant_id),
            eq(knowledgeChunks.knowledge_source_id, prior.id),
          ),
        );
      await insertKnowledgeChunks(tx, p.tenant_id, prior.id, [
        {
          title: p.chunk_title,
          path: p.source_uri,
          content: p.json,
          byte_size: p.bytes,
          fingerprint: p.version,
        },
      ]);
      await recordKnowledgeVersion(tx, {
        tenant_id: p.tenant_id,
        knowledge_source_id: prior.id,
        content: p.content,
        content_hash: p.version,
        actor: p.actor,
        note: null,
      });
      return { row_id: prior.id, cached_at: p.now.toISOString(), created: false };
    }

    const [inserted] = await tx
      .insert(knowledgeSources)
      .values({
        tenant_id: p.tenant_id,
        name: p.name,
        slug: p.slug,
        description: p.description,
        scope: "global",
        workflow_id: null,
        status: "active",
        source_type: p.source_type,
        source_uri: p.source_uri,
        mime_type: "application/json",
        version: p.version,
        bytes_total: p.bytes,
        chunk_count: 1,
        refresh_strategy: "manual",
        last_refreshed_at: p.now,
      })
      .returning();
    assertInsertRow(inserted, "knowledge_sources");
    await insertKnowledgeChunks(tx, p.tenant_id, inserted.id, [
      {
        title: p.chunk_title,
        path: p.source_uri,
        content: p.json,
        byte_size: p.bytes,
        fingerprint: p.version,
      },
    ]);
    await recordKnowledgeVersion(tx, {
      tenant_id: p.tenant_id,
      knowledge_source_id: inserted.id,
      content: p.content,
      content_hash: p.version,
      actor: p.actor,
      note: null,
    });
    return { row_id: inserted.id, cached_at: p.now.toISOString(), created: true };
  });
}
