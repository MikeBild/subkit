import { and, asc, eq, isNull } from "drizzle-orm";
import { type Db, type Executor, getDb } from "../db/client.ts";
import { knowledgeChunks, knowledgeSources } from "../db/schema/knowledge_sources.ts";
import { canonicalBundleSerialization, normalizeBundlePath, parseBundle } from "./bundle.ts";
import { getKnowledgeSource } from "./catalog.ts";
import {
  KnowledgeBundleDocumentLimitError,
  KnowledgeBundleRequiredError,
  KnowledgeContentReadOnlyError,
  KnowledgeDocumentPathExistsError,
  KnowledgeDocumentPathInvalidError,
  KnowledgeVersionConflictError,
} from "./errors.ts";
import { cleanupPersistedKnowledgeFile } from "./file-persist.ts";
import { applyKnowledgeIngest, finishKnowledgeWrite, prepareKnowledgeIngest } from "./service.ts";
import type {
  AppendKnowledgeSourceDocumentParams,
  KnowledgeSourceContent,
  KnowledgeSourceView,
  UpdateKnowledgeSourceContentParams,
} from "./types.ts";

export {
  KnowledgeBundleDocumentLimitError,
  KnowledgeBundleRequiredError,
  KnowledgeContentReadOnlyError,
  KnowledgeDocumentPathExistsError,
  KnowledgeDocumentPathInvalidError,
  KnowledgeVersionConflictError,
} from "./errors.ts";

const MAX_BUNDLE_DOCUMENTS = 500;

interface LockedKnowledgeSource {
  version: string;
  slug: string;
  source_type: string;
}

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
    .orderBy(asc(knowledgeChunks.ordinal));
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

function assertAppendableBundlePath(path: string): string {
  if (
    path.includes("\\") ||
    path.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    throw new KnowledgeDocumentPathInvalidError();
  }
  const normalized = normalizeBundlePath(path);
  const basename = normalized.slice(normalized.lastIndexOf("/") + 1).toLowerCase();
  if (
    normalized === "/" ||
    !normalized.toLowerCase().endsWith(".md") ||
    basename === "index.md" ||
    basename === "log.md"
  ) {
    throw new KnowledgeDocumentPathInvalidError();
  }
  return normalized;
}

async function lockKnowledgeSourceForContent(
  tx: Executor,
  tenant_id: string,
  knowledge_source_id: string,
): Promise<LockedKnowledgeSource | null> {
  const [source] = await tx
    .select({
      version: knowledgeSources.version,
      slug: knowledgeSources.slug,
      source_type: knowledgeSources.source_type,
    })
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.tenant_id, tenant_id),
        eq(knowledgeSources.id, knowledge_source_id),
        isNull(knowledgeSources.deleted_at),
      ),
    )
    .for("update")
    .limit(1);
  return source ?? null;
}

async function ingestContentMutation(
  db: Db,
  p: UpdateKnowledgeSourceContentParams,
  change: (
    current: KnowledgeSourceContent,
    source: LockedKnowledgeSource,
  ) => { path: string; files?: KnowledgeSourceContent["documents"]; content: string } | null,
): Promise<{ path: string; content: KnowledgeSourceContent } | null> {
  let persisted: Awaited<ReturnType<typeof prepareKnowledgeIngest>>["persisted"] = null;
  let changed: string | null;
  try {
    changed = await db.transaction(async (tx) => {
      const source = await lockKnowledgeSourceForContent(tx, p.tenant_id, p.knowledge_source_id);
      if (!source) return null;
      if (source.version !== p.expected_version) {
        throw new KnowledgeVersionConflictError(p.expected_version, source.version);
      }
      const current = await getKnowledgeSourceContent(p.tenant_id, p.knowledge_source_id, tx);
      if (!current) return null;
      const next = change(current, source);
      if (!next) return null;
      const upload =
        next.files === undefined
          ? {
              buffer: Buffer.from(next.content, "utf8"),
              filename: next.path,
              mime: "text/markdown",
            }
          : {
              buffer: Buffer.from(canonicalBundleSerialization(next.files), "utf8"),
              filename: `${source.slug}.bundle.json`,
              mime: "application/json",
            };
      const params = {
        tenant_id: p.tenant_id,
        knowledge_source_id: p.knowledge_source_id,
        expected_version: p.expected_version,
        actor: p.actor,
        ...(p.note !== undefined ? { note: p.note } : {}),
        upload,
        ...(next.files === undefined ? {} : { parsed_chunks: parseBundle(next.files).chunks }),
      };
      const prepared = await prepareKnowledgeIngest(params, tx);
      persisted = prepared.persisted;
      await applyKnowledgeIngest(tx, params, prepared);
      return next.path;
    });
  } catch (error) {
    await cleanupPersistedKnowledgeFile(db, persisted);
    throw error;
  }
  if (changed === null) return null;
  finishKnowledgeWrite(p.tenant_id, p.knowledge_source_id, db);
  const content = await getKnowledgeSourceContent(p.tenant_id, p.knowledge_source_id, db);
  if (!content) return null;
  return { path: changed, content };
}

export async function appendKnowledgeSourceDocument(
  p: AppendKnowledgeSourceDocumentParams,
  exec?: Executor,
): Promise<KnowledgeSourceContent | null> {
  const db = exec ?? getDb();
  const normalizedPath = assertAppendableBundlePath(p.path);
  const result = await ingestContentMutation(
    db as Db,
    { ...p, path: normalizedPath },
    (current, source) => {
      if (source.source_type !== "bundle")
        throw new KnowledgeBundleRequiredError(source.source_type);
      if (current.documents.some((document) => document.path === normalizedPath)) {
        throw new KnowledgeDocumentPathExistsError(normalizedPath);
      }
      if (current.documents.length >= MAX_BUNDLE_DOCUMENTS) {
        throw new KnowledgeBundleDocumentLimitError(MAX_BUNDLE_DOCUMENTS);
      }
      return {
        path: normalizedPath,
        content: p.content,
        files: [...current.documents, { path: normalizedPath, content: p.content }],
      };
    },
  );
  return result?.content ?? null;
}

export async function updateKnowledgeSourceContent(
  p: UpdateKnowledgeSourceContentParams,
  exec?: Executor,
): Promise<KnowledgeSourceContent | null> {
  const db = exec ?? getDb();
  const result = await ingestContentMutation(db as Db, p, (current, source) => {
    if (!current.editable) throw new KnowledgeContentReadOnlyError();
    if (source.source_type !== "bundle") return { path: p.path, content: p.content };
    let matched = false;
    const files = current.documents.map((document) => {
      if (document.path !== p.path) return document;
      matched = true;
      return { ...document, content: p.content };
    });
    if (!matched) return null;
    return { path: p.path, content: p.content, files };
  });
  return result?.content ?? null;
}
