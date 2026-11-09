import { and, desc, eq, lte } from "drizzle-orm";
import { type Actor, actorIds } from "../audit/actor.ts";
import type { Executor } from "../db/client.ts";
import {
  type KnowledgeVersionContent,
  knowledgeSourceVersions,
} from "../db/schema/knowledge_sources.ts";

export type { KnowledgeVersionContent } from "../db/schema/knowledge_sources.ts";

export const KNOWLEDGE_VERSIONS_KEPT = 50;

export { knowledgeContentHash } from "./core/content.ts";
export {
  knowledgeVersionContent,
  knowledgeVersionDocuments,
  knowledgeVersionUpload,
  restoredNote,
} from "./core/version-content.ts";

export async function latestKnowledgeVersion(
  exec: Executor,
  tenant_id: string,
  knowledge_source_id: string,
): Promise<{ version: number; content_hash: string } | null> {
  const [latest] = await exec
    .select({
      version: knowledgeSourceVersions.version,
      content_hash: knowledgeSourceVersions.content_hash,
    })
    .from(knowledgeSourceVersions)
    .where(
      and(
        eq(knowledgeSourceVersions.tenant_id, tenant_id),
        eq(knowledgeSourceVersions.knowledge_source_id, knowledge_source_id),
      ),
    )
    .orderBy(desc(knowledgeSourceVersions.version))
    .limit(1);
  return latest ?? null;
}

export async function recordKnowledgeVersion(
  tx: Executor,
  p: {
    tenant_id: string;
    knowledge_source_id: string;
    content: KnowledgeVersionContent;
    content_hash: string;
    actor: Actor | null;
    note: string | null;
  },
): Promise<number | null> {
  const latest = await latestKnowledgeVersion(tx, p.tenant_id, p.knowledge_source_id);
  if (latest && latest.content_hash === p.content_hash) return null;
  const version = (latest?.version ?? 0) + 1;
  const author = actorIds(p.actor);
  await tx.insert(knowledgeSourceVersions).values({
    tenant_id: p.tenant_id,
    knowledge_source_id: p.knowledge_source_id,
    version,
    content: p.content,
    content_hash: p.content_hash,
    author_user_id: author.user_id,
    author_system_account_id: author.system_account_id,
    note: p.note,
  });
  await tx
    .delete(knowledgeSourceVersions)
    .where(
      and(
        eq(knowledgeSourceVersions.tenant_id, p.tenant_id),
        eq(knowledgeSourceVersions.knowledge_source_id, p.knowledge_source_id),
        lte(knowledgeSourceVersions.version, version - KNOWLEDGE_VERSIONS_KEPT),
      ),
    );
  return version;
}

export async function forgetKnowledgeVersions(
  tx: Executor,
  tenant_id: string,
  knowledge_source_id: string,
): Promise<void> {
  await tx
    .delete(knowledgeSourceVersions)
    .where(
      and(
        eq(knowledgeSourceVersions.tenant_id, tenant_id),
        eq(knowledgeSourceVersions.knowledge_source_id, knowledge_source_id),
      ),
    );
}
