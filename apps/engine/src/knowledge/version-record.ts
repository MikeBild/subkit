import { and, desc, eq } from "drizzle-orm";
import { type Actor, actorIds } from "../audit/actor.ts";
import type { Executor } from "../db/client.ts";
import {
  type KnowledgeVersionContent,
  knowledgeSourceVersions,
} from "../db/schema/knowledge_sources.ts";
import type { RawChunk } from "../docs-ingestion/types.ts";

export type { KnowledgeVersionContent } from "../db/schema/knowledge_sources.ts";

export const RESTORED_NOTE_PREFIX = "restored from v";

export function restoredNote(version: number): string {
  return `${RESTORED_NOTE_PREFIX}${version}`;
}

export function learningNote(proposer: Actor | null): string {
  return proposer ? `proposed by ${proposer.kind}:${proposer.id}` : "proposed by an agent";
}

export function knowledgeVersionContent(p: {
  source_type: string;
  upload: { filename: string; mime?: string | undefined };
  text: string;
  parsed_chunks?: RawChunk[] | undefined;
}): KnowledgeVersionContent {
  if (p.source_type === "bundle") {
    return {
      kind: "bundle",
      filename: p.upload.filename,
      files: (p.parsed_chunks ?? []).map((chunk) => ({
        path: chunk.path ?? p.upload.filename,
        content: chunk.content,
      })),
    };
  }
  return {
    kind: "document",
    filename: p.upload.filename,
    mime: p.upload.mime ?? null,
    text: p.text.replaceAll("\u0000", ""),
  };
}

export function knowledgeVersionDocuments(
  content: KnowledgeVersionContent,
): { path: string; content: string }[] {
  if (content.kind === "document") return [{ path: content.filename, content: content.text }];
  return content.files;
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
  const [latest] = await tx
    .select({
      version: knowledgeSourceVersions.version,
      content_hash: knowledgeSourceVersions.content_hash,
    })
    .from(knowledgeSourceVersions)
    .where(
      and(
        eq(knowledgeSourceVersions.tenant_id, p.tenant_id),
        eq(knowledgeSourceVersions.knowledge_source_id, p.knowledge_source_id),
      ),
    )
    .orderBy(desc(knowledgeSourceVersions.version))
    .limit(1);
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
  return version;
}
