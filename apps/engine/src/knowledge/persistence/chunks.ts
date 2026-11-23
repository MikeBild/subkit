import { eq, sql } from "drizzle-orm";
import { type Executor, knowledgeChunks, tenants } from "../../db/index.ts";
import { type FtsConfig, ftsConfigFor } from "../core/fts-config.ts";

export async function workspaceFtsConfig(db: Executor, tenant_id: string): Promise<FtsConfig> {
  const [row] = await db
    .select({ language: tenants.language })
    .from(tenants)
    .where(eq(tenants.id, tenant_id))
    .limit(1);
  return ftsConfigFor(row?.language);
}

export interface KnowledgeChunkInput {
  title?: string | null;
  path?: string | null;
  content: string;
  byte_size: number;
  fingerprint: string;
}

export async function insertKnowledgeChunks(
  tx: Executor,
  tenant_id: string,
  knowledge_source_id: string,
  chunks: readonly KnowledgeChunkInput[],
): Promise<void> {
  if (chunks.length === 0) return;
  const fts_config = await workspaceFtsConfig(tx, tenant_id);
  await tx.insert(knowledgeChunks).values(
    chunks.map((c, i) => ({
      tenant_id,
      knowledge_source_id,
      ordinal: i,
      title: c.title ?? null,
      path: c.path ?? null,
      content: c.content,
      byte_size: c.byte_size,
      fingerprint: c.fingerprint,
      fts_config,
    })),
  );
}
