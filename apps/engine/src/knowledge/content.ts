import { and, asc, eq } from "drizzle-orm";

import { type Executor, getDb } from "../db/client.ts";
import { knowledgeChunks } from "../db/schema/knowledge_sources.ts";
import { canonicalBundleSerialization, parseBundle } from "./bundle.ts";
import { getKnowledgeSource } from "./catalog.ts";
import { KnowledgeContentReadOnlyError, KnowledgeVersionConflictError } from "./errors.ts";
import { ingestKnowledgeSource } from "./service.ts";
import type {
  KnowledgeSourceContent,
  KnowledgeSourceView,
  UpdateKnowledgeSourceContentParams,
} from "./types.ts";

export { KnowledgeContentReadOnlyError, KnowledgeVersionConflictError } from "./errors.ts";

function isEditableMarkdownSource(source: KnowledgeSourceView): boolean {
  if (source.source_type === "bundle") return true;
  if (source.source_type !== "inline" && source.source_type !== "file_upload") return false;
  return source.mime_type === "text/markdown" || /\.md(?:own)?$/i.test(source.source_uri);
}

export async function getKnowledgeSourceContent(
  tenant_id: string,
  knowledge_source_id: string,
  exec?: Executor,
): Promise<KnowledgeSourceContent | null> {
  const db = exec ?? getDb();
  const source = await getKnowledgeSource(tenant_id, knowledge_source_id, db);
  if (!source) return null;
  const chunks = await db
    .select({ path: knowledgeChunks.path, content: knowledgeChunks.content })
    .from(knowledgeChunks)
    .where(
      and(
        eq(knowledgeChunks.tenant_id, tenant_id),
        eq(knowledgeChunks.knowledge_source_id, knowledge_source_id),
      ),
    )
    .orderBy(asc(knowledgeChunks.ordinal))
    .limit(200);
  const documents =
    source.source_type === "bundle"
      ? chunks.map((chunk) => ({
          path: chunk.path ?? `/${source.slug}.md`,
          content: chunk.content,
        }))
      : [
          {
            path: source.source_uri,
            content: chunks.map((chunk) => chunk.content).join("\n\n"),
          },
        ];
  return {
    knowledge_source_id: source.id,
    version: source.version,
    editable: isEditableMarkdownSource(source),
    documents,
  };
}

export async function updateKnowledgeSourceContent(
  p: UpdateKnowledgeSourceContentParams,
  exec?: Executor,
): Promise<KnowledgeSourceContent | null> {
  const db = exec ?? getDb();
  const current = await getKnowledgeSourceContent(p.tenant_id, p.knowledge_source_id, db);
  if (!current) return null;
  if (!current.editable) throw new KnowledgeContentReadOnlyError();
  if (current.version !== p.expected_version) {
    throw new KnowledgeVersionConflictError(p.expected_version, current.version);
  }
  const source = await getKnowledgeSource(p.tenant_id, p.knowledge_source_id, db);
  if (!source) return null;

  if (source.source_type === "bundle") {
    let matched = false;
    const files = current.documents.map((document) => {
      if (document.path !== p.path) return document;
      matched = true;
      return { ...document, content: p.content };
    });
    if (!matched) return null;
    const parsed = parseBundle(files);
    await ingestKnowledgeSource(
      {
        tenant_id: p.tenant_id,
        knowledge_source_id: p.knowledge_source_id,
        expected_version: p.expected_version,
        actor_id: p.actor_id,
        upload: {
          buffer: Buffer.from(canonicalBundleSerialization(files), "utf8"),
          filename: `${source.slug}.bundle.json`,
          mime: "application/json",
        },
        parsed_chunks: parsed.chunks,
      },
      db,
    );
  } else {
    await ingestKnowledgeSource(
      {
        tenant_id: p.tenant_id,
        knowledge_source_id: p.knowledge_source_id,
        expected_version: p.expected_version,
        actor_id: p.actor_id,
        upload: {
          buffer: Buffer.from(p.content, "utf8"),
          filename: source.source_uri,
          mime: "text/markdown",
        },
      },
      db,
    );
  }
  return await getKnowledgeSourceContent(p.tenant_id, p.knowledge_source_id, db);
}
