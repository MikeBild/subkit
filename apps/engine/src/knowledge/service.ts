import { and, asc, eq, isNull, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { humanMetadataWrite, metadataChange } from "../api/catalog-metadata.ts";
import { auditActor } from "../audit/actor.ts";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Db, type Executor, getDb } from "../db/client.ts";
import { knowledgeChunks, knowledgeSources } from "../db/schema/knowledge_sources.ts";
import { fingerprintChunks } from "../docs-ingestion/chunker.ts";
import { dedupChunks } from "../docs-ingestion/dedup.ts";
import type { FingerprintedChunk } from "../docs-ingestion/types.ts";
import { backfillEmbeddings } from "../embeddings/backfill.ts";
import { embeddingsAvailable } from "../embeddings/local-provider.ts";
import { fuseVectorFirst, vectorScoreCandidates } from "../embeddings/vector-rerank.ts";
import type { PersistInlineUploadResult } from "../files/persist-inline-upload.ts";
import { invoke } from "../llm/core/invoke.ts";
import { errorFields, log, logger } from "../logging/logger.ts";
import { instrument } from "../observability/runtime-telemetry.ts";
import { emitResourceChange } from "../pubsub/resource-changes.ts";
import { TtlCache } from "../utils/ttl-cache.ts";
import { describeOne } from "../workflows/catalog-describe.ts";
import {
  assertTenantKnowledgeBudget,
  KNOWLEDGE_SOURCE_MAX_BYTES,
  KnowledgeBudgetExceededError,
} from "./budgets.ts";
import { KnowledgeVersionAlreadyCurrentError, KnowledgeVersionConflictError } from "./errors.ts";
import { linkKnowledgeFile, persistKnowledgeFile } from "./file-persist.ts";
import { detectFormat, parseFileToChunks } from "./parsers.ts";
import { dedupeTags, mergeStructuralTags } from "./tags.ts";
import type {
  AnalyzeKnowledgeSourceParams,
  CreateKnowledgeSourceParams,
  IngestKnowledgeSourceParams,
  KnowledgeIngestResult,
  KnowledgeSearchHit,
  KnowledgeSourceView,
  SearchKnowledgeParams,
  UpdateKnowledgeSourceParams,
} from "./types.ts";
import {
  forgetKnowledgeVersions,
  type KnowledgeVersionContent,
  knowledgeContentHash,
  knowledgeVersionContent,
  latestKnowledgeVersion,
  recordKnowledgeVersion,
  restoredNote,
} from "./version-record.ts";
import { knowledgeSourceRowToView } from "./view.ts";

export { countKnowledgeSources, getKnowledgeSource, listKnowledgeSources } from "./catalog.ts";
export { knowledgeSourceRowToView } from "./view.ts";

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

export async function knowledgeSourceChanged(
  tx: Executor,
  tenant_id: string,
  knowledge_source_id: string,
): Promise<void> {
  await emitResourceChange(tx, {
    tenant_id,
    type: "knowledge_source.changed",
    ids: { knowledge_source_id },
  });
}

export async function kickSourceEmbeddingBackfill(
  tenant_id: string,
  knowledge_source_id: string,
  db: Executor,
): Promise<void> {
  try {
    if (!(await embeddingsAvailable())) return;
    const result = await backfillEmbeddings({ tenant_id, knowledge_source_id }, db);
    if (result.knowledge.embedded > 0) invalidateKnowledgeCache(tenant_id);
  } catch (err) {
    logger.warn({
      module: "knowledge",
      action: "embedding.backfill_kick_failed",
      msg: "post-ingest embedding backfill failed — the scheduler sweep will retry",
      tenant_id,
      knowledge_source_id,
      ...errorFields(err),
    });
  }
}

function decodeUpload(buffer: Buffer | Uint8Array | string): string {
  return typeof buffer === "string" ? buffer : new TextDecoder().decode(buffer);
}

function assertSourceSize(content: string): void {
  const byteSize = Buffer.byteLength(content, "utf8");
  if (byteSize > KNOWLEDGE_SOURCE_MAX_BYTES) {
    throw new KnowledgeBudgetExceededError(
      `File exceeds maximum size of ${KNOWLEDGE_SOURCE_MAX_BYTES} bytes`,
      byteSize,
      KNOWLEDGE_SOURCE_MAX_BYTES,
    );
  }
}

export interface PreparedKnowledgeCreate {
  slug: string;
  hash: string;
  source_type: NonNullable<CreateKnowledgeSourceParams["source_type_override"]>;
  accepted: FingerprintedChunk[];
  skipped: number;
  total_bytes: number;
  persisted: PersistInlineUploadResult | null;
  content: KnowledgeVersionContent;
}

export async function prepareKnowledgeCreate(
  p: CreateKnowledgeSourceParams,
  db: Executor,
): Promise<PreparedKnowledgeCreate> {
  if (p.input.scope === "workflow" && !p.input.workflow_id) {
    throw new Error("workflow_id is required when scope is 'workflow'");
  }
  const content = decodeUpload(p.upload.buffer);
  assertSourceSize(content);
  const format = detectFormat(p.upload.filename, p.upload.mime);
  const rawChunks = p.parsed_chunks ?? parseFileToChunks(content, p.upload.filename, format);
  const fingerprinted = fingerprintChunks(rawChunks);
  const { accepted, skipped } = p.parsed_chunks
    ? { accepted: fingerprinted, skipped: 0 }
    : dedupChunks(fingerprinted);
  const source_type = p.source_type_override ?? "file_upload";
  return {
    slug: p.input.slug ?? toSlug(p.input.name),
    hash: knowledgeContentHash(content),
    source_type,
    accepted,
    skipped,
    total_bytes: accepted.reduce((s, c) => s + c.byte_size, 0),
    persisted: source_type === "url" ? null : await persistKnowledgeFile(db, p),
    content: knowledgeVersionContent({
      source_type,
      upload: p.upload,
      text: content,
      parsed_chunks: p.parsed_chunks,
    }),
  };
}

export async function applyKnowledgeCreate(
  tx: Executor,
  p: CreateKnowledgeSourceParams,
  prepared: PreparedKnowledgeCreate,
): Promise<KnowledgeSourceView> {
  const { slug, accepted } = prepared;
  await assertTenantKnowledgeBudget(tx, p.tenant_id, prepared.total_bytes);

  const [row] = await tx
    .insert(knowledgeSources)
    .values({
      tenant_id: p.tenant_id,
      name: p.input.name,
      slug,
      ...humanMetadataWrite({
        ...(p.input.description !== undefined ? { description: p.input.description } : {}),
        ...(p.input.category !== undefined ? { category: p.input.category } : {}),
      }),
      tags: dedupeTags(p.input.tags ?? []),
      scope: p.input.scope ?? "global",
      workflow_id: p.input.workflow_id ?? null,
      status: "active",
      source_type: prepared.source_type,
      source_uri: p.source_uri_override ?? p.upload.filename,
      mime_type: p.upload.mime ?? null,
      file_id: prepared.persisted ? prepared.persisted.row.id : null,
      version: prepared.hash,
      bytes_total: prepared.total_bytes,
      chunk_count: accepted.length,
      refresh_strategy: p.input.refresh_strategy ?? "manual",
      refresh_cron: p.input.refresh_cron ?? null,
      last_refreshed_at: new Date(),
    })
    .returning();

  assertInsertRow(row, "knowledge_sources");

  if (prepared.persisted) {
    await linkKnowledgeFile(tx, {
      tenant_id: p.tenant_id,
      actor_id: p.actor?.id ?? null,
      knowledge_source_id: row.id,
      slug,
      filename: p.upload.filename,
      mime: p.upload.mime ?? null,
      persisted: prepared.persisted,
    });
  }

  if (accepted.length > 0) {
    await tx.insert(knowledgeChunks).values(
      accepted.map((c, i) => ({
        tenant_id: p.tenant_id,
        knowledge_source_id: row.id,
        ordinal: i,
        title: c.title ?? null,
        path: c.path ?? null,
        content: c.content,
        byte_size: c.byte_size,
        fingerprint: c.fingerprint,
      })),
    );
  }

  await recordKnowledgeVersion(tx, {
    tenant_id: p.tenant_id,
    knowledge_source_id: row.id,
    content: prepared.content,
    content_hash: prepared.hash,
    actor: p.actor,
    note: p.note ?? null,
  });

  await auditAwait(
    {
      tenant_id: p.tenant_id,
      ...auditActor(p.actor),
      action: AuditAction.KNOWLEDGE_SOURCE_CREATED,
      resource_type: "knowledge_source",
      resource_id: row.id,
      result: "success",
      metadata: {
        slug,
        scope: p.input.scope ?? "global",
        chunk_count: accepted.length,
        skipped_count: prepared.skipped,
        bytes_total: prepared.total_bytes,
        source_uri: p.source_uri_override ?? p.upload.filename,
      },
    },
    tx,
  );
  await knowledgeSourceChanged(tx, p.tenant_id, row.id);
  return knowledgeSourceRowToView(row);
}

export function finishKnowledgeWrite(
  tenant_id: string,
  knowledge_source_id: string,
  db: Executor,
): void {
  invalidateKnowledgeCache(tenant_id);
  void kickSourceEmbeddingBackfill(tenant_id, knowledge_source_id, db);
}

export async function createKnowledgeSource(
  p: CreateKnowledgeSourceParams,
  exec?: Executor,
): Promise<KnowledgeSourceView> {
  const db = exec ?? getDb();
  const prepared = await prepareKnowledgeCreate(p, db);
  const created = await (db as Db).transaction((tx) => applyKnowledgeCreate(tx, p, prepared));
  finishKnowledgeWrite(p.tenant_id, created.id, db);
  return created;
}

export async function getKnowledgeSourceBySlug(
  tenant_id: string,
  slug: string,
  exec?: Executor,
): Promise<KnowledgeSourceView | null> {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.tenant_id, tenant_id),
        eq(knowledgeSources.slug, slug),
        isNull(knowledgeSources.deleted_at),
      ),
    )
    .limit(1);
  return rows[0] ? knowledgeSourceRowToView(rows[0]) : null;
}

export async function updateKnowledgeSource(
  p: UpdateKnowledgeSourceParams,
  exec?: Executor,
): Promise<KnowledgeSourceView | null> {
  const db = exec ?? getDb();

  return await (db as Db).transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(knowledgeSources)
      .where(
        and(
          eq(knowledgeSources.tenant_id, p.tenant_id),
          eq(knowledgeSources.id, p.id),
          isNull(knowledgeSources.deleted_at),
        ),
      )
      .limit(1);

    if (!existing[0]) return null;
    const before = knowledgeSourceRowToView(existing[0]);

    const effectiveScope = p.patch.scope ?? existing[0].scope;
    const effectiveWorkflowId =
      p.patch.workflow_id !== undefined ? p.patch.workflow_id : existing[0].workflow_id;
    if (effectiveScope === "workflow" && !effectiveWorkflowId) {
      throw new Error("workflow_id is required when scope is 'workflow'");
    }

    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (p.patch.name !== undefined) updates.name = p.patch.name;
    Object.assign(
      updates,
      metadataChange(existing[0], {
        ...(p.patch.description !== undefined ? { description: p.patch.description } : {}),
        ...(p.patch.category !== undefined ? { category: p.patch.category } : {}),
      }),
    );
    if (p.patch.tags !== undefined) updates.tags = dedupeTags(p.patch.tags);
    if (p.patch.scope !== undefined) updates.scope = p.patch.scope;
    if (p.patch.workflow_id !== undefined) updates.workflow_id = p.patch.workflow_id;
    if (p.patch.status !== undefined) updates.status = p.patch.status;
    if (p.patch.refresh_strategy !== undefined) updates.refresh_strategy = p.patch.refresh_strategy;
    if (p.patch.refresh_cron !== undefined) updates.refresh_cron = p.patch.refresh_cron;

    const [updated] = await tx
      .update(knowledgeSources)
      .set(updates)
      .where(eq(knowledgeSources.id, p.id))
      .returning();

    if (!updated) return null;

    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.KNOWLEDGE_SOURCE_UPDATED,
        resource_type: "knowledge_source",
        resource_id: p.id,
        result: "success",
        before,
        after: knowledgeSourceRowToView(updated),
        metadata: {},
      },
      tx,
    );
    await knowledgeSourceChanged(tx, p.tenant_id, p.id);

    return knowledgeSourceRowToView(updated);
  });
}

const ANALYZE_SAMPLE_MAX_CHARS = 28_000;

const AnalysisSchema = z.object({
  tags: z.array(z.string().min(1).max(40)).min(1).max(8),
});

export async function analyzeKnowledgeSource(
  p: AnalyzeKnowledgeSourceParams,
  exec?: Executor,
): Promise<KnowledgeSourceView | null> {
  const db = exec ?? getDb();

  const sources = await db
    .select()
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.tenant_id, p.tenant_id),
        eq(knowledgeSources.id, p.id),
        isNull(knowledgeSources.deleted_at),
      ),
    )
    .limit(1);
  const source = sources[0];
  if (!source) return null;

  const chunks = await db
    .select({
      title: knowledgeChunks.title,
      path: knowledgeChunks.path,
      content: knowledgeChunks.content,
    })
    .from(knowledgeChunks)
    .where(
      and(
        eq(knowledgeChunks.tenant_id, p.tenant_id),
        eq(knowledgeChunks.knowledge_source_id, p.id),
      ),
    )
    .orderBy(asc(knowledgeChunks.ordinal))
    .limit(20);

  let sample = "";
  for (const c of chunks) {
    const heading = c.title ?? c.path ?? "";
    const block = heading ? `## ${heading}\n${c.content}\n\n` : `${c.content}\n\n`;
    if (sample.length + block.length > ANALYZE_SAMPLE_MAX_CHARS) {
      sample += block.slice(0, ANALYZE_SAMPLE_MAX_CHARS - sample.length);
      break;
    }
    sample += block;
  }

  if (sample.trim().length === 0) {
    return knowledgeSourceRowToView(source);
  }

  const prompt = [
    `You are cataloguing an enterprise Knowledge Source named "${source.name}".`,
    "Return 3-8 short lowercase topical tags for routing and filtering (single words or",
    'short phrases, e.g. "billing", "oauth", "compliance"). Do not restate the source name as a tag.',
    "",
    "Source content sample:",
    sample,
  ].join("\n");

  const result = await invoke<z.infer<typeof AnalysisSchema>>(
    {
      flow: "extract",
      tenant_id: p.tenant_id,
      user_turns: [{ role: "user", content: prompt }],
      schema: AnalysisSchema,
    },
    db,
  );

  const analysis = result.object;
  if (!analysis) {
    return knowledgeSourceRowToView(source);
  }

  const nextTags = mergeStructuralTags(source.tags ?? [], analysis.tags);

  const tagged = await (db as Db).transaction(async (tx) => {
    const [updated] = await tx
      .update(knowledgeSources)
      .set({
        tags: nextTags,
        updated_at: new Date(),
        ...(p.force === true ? { catalog_input_hash: null } : {}),
      })
      .where(and(eq(knowledgeSources.tenant_id, p.tenant_id), eq(knowledgeSources.id, p.id)))
      .returning();

    if (!updated) return null;

    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.KNOWLEDGE_SOURCE_ANALYZED,
        resource_type: "knowledge_source",
        resource_id: p.id,
        result: "success",
        metadata: {
          tags: nextTags,
          model_used: result.model_used,
          force: p.force === true,
        },
      },
      tx,
    );
    await knowledgeSourceChanged(tx, p.tenant_id, p.id);
    return updated;
  });
  if (!tagged) return null;

  await describeOne({ tenant_id: p.tenant_id, kind: "knowledge_source", id: p.id }, db);
  invalidateKnowledgeCache(p.tenant_id);
  const [fresh] = await db
    .select()
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.tenant_id, p.tenant_id), eq(knowledgeSources.id, p.id)))
    .limit(1);
  return knowledgeSourceRowToView(fresh ?? tagged);
}

export async function deleteKnowledgeSource(
  tenant_id: string,
  id: string,
  actor_id: string | null,
  exec?: Executor,
): Promise<boolean> {
  const db = exec ?? getDb();

  return await (db as Db).transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(knowledgeSources)
      .where(
        and(
          eq(knowledgeSources.tenant_id, tenant_id),
          eq(knowledgeSources.id, id),
          isNull(knowledgeSources.deleted_at),
        ),
      )
      .limit(1);

    if (!existing[0]) return false;

    await tx
      .update(knowledgeSources)
      .set({ deleted_at: new Date(), updated_at: new Date() })
      .where(eq(knowledgeSources.id, id));
    await forgetKnowledgeVersions(tx, tenant_id, id);

    await auditAwait(
      {
        tenant_id,
        actor_type: actor_id ? "user" : "system",
        actor_id,
        action: AuditAction.KNOWLEDGE_SOURCE_DELETED,
        resource_type: "knowledge_source",
        resource_id: id,
        result: "success",
        metadata: { slug: existing[0].slug },
      },
      tx,
    );
    await knowledgeSourceChanged(tx, tenant_id, id);

    invalidateKnowledgeCache(tenant_id);
    return true;
  });
}

export interface PreparedKnowledgeIngest {
  format: ReturnType<typeof detectFormat>;
  hash: string;
  accepted: FingerprintedChunk[];
  skipped: number;
  total_bytes: number;
  persisted: PersistInlineUploadResult | null;
  source_slug: string;
  content: KnowledgeVersionContent;
}

export interface AppliedKnowledgeIngest {
  version: number | null;
}

export async function prepareKnowledgeIngest(
  p: IngestKnowledgeSourceParams,
  db: Executor,
): Promise<PreparedKnowledgeIngest> {
  const content = decodeUpload(p.upload.buffer);
  assertSourceSize(content);
  const byteSize = Buffer.byteLength(content, "utf8");

  const format = detectFormat(p.upload.filename, p.upload.mime);
  const rawChunks = await instrument({
    module: "knowledge",
    action: "parse_file_to_chunks",
    memory: true,
    fields: {
      knowledge_source_id: p.knowledge_source_id,
      tenant_id: p.tenant_id,
      format,
      byte_size: byteSize,
    },
    fn: () => p.parsed_chunks ?? parseFileToChunks(content, p.upload.filename, format),
  });
  const fingerprinted = fingerprintChunks(rawChunks);
  const { accepted, skipped } = p.parsed_chunks
    ? { accepted: fingerprinted, skipped: 0 }
    : dedupChunks(fingerprinted);

  const sourceRows = await db
    .select({ source_type: knowledgeSources.source_type, slug: knowledgeSources.slug })
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.tenant_id, p.tenant_id),
        eq(knowledgeSources.id, p.knowledge_source_id),
        isNull(knowledgeSources.deleted_at),
      ),
    )
    .limit(1);
  const sourceRow = sourceRows[0];
  const keepsFile = sourceRow !== undefined && sourceRow.source_type !== "url";
  return {
    format,
    hash: knowledgeContentHash(content),
    accepted,
    skipped,
    total_bytes: accepted.reduce((s, c) => s + c.byte_size, 0),
    persisted: keepsFile ? await persistKnowledgeFile(db, p) : null,
    source_slug: keepsFile ? sourceRow.slug : p.upload.filename,
    content: knowledgeVersionContent({
      source_type: sourceRow?.source_type ?? "file_upload",
      upload: p.upload,
      text: content,
      parsed_chunks: p.parsed_chunks,
    }),
  };
}

export async function applyKnowledgeIngest(
  tx: Executor,
  p: IngestKnowledgeSourceParams,
  prepared: PreparedKnowledgeIngest,
): Promise<AppliedKnowledgeIngest | null> {
  const { accepted } = prepared;
  const [lockedSource] = await tx
    .select({ version: knowledgeSources.version, slug: knowledgeSources.slug })
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
  if (!lockedSource) return null;
  if (p.expected_version !== undefined && lockedSource.version !== p.expected_version) {
    throw new KnowledgeVersionConflictError(p.expected_version, lockedSource.version);
  }
  if (p.restored_from !== undefined) {
    const latest = await latestKnowledgeVersion(tx, p.tenant_id, p.knowledge_source_id);
    if (latest?.content_hash === prepared.hash) {
      throw new KnowledgeVersionAlreadyCurrentError(p.restored_from);
    }
  }
  await assertTenantKnowledgeBudget(tx, p.tenant_id, prepared.total_bytes, p.knowledge_source_id);

  await tx
    .delete(knowledgeChunks)
    .where(
      and(
        eq(knowledgeChunks.tenant_id, p.tenant_id),
        eq(knowledgeChunks.knowledge_source_id, p.knowledge_source_id),
      ),
    );

  if (accepted.length > 0) {
    await tx.insert(knowledgeChunks).values(
      accepted.map((c, i) => ({
        tenant_id: p.tenant_id,
        knowledge_source_id: p.knowledge_source_id,
        ordinal: i,
        title: c.title ?? null,
        path: c.path ?? null,
        content: c.content,
        byte_size: c.byte_size,
        fingerprint: c.fingerprint,
      })),
    );
  }

  await tx
    .update(knowledgeSources)
    .set({
      version: prepared.hash,
      bytes_total: prepared.total_bytes,
      chunk_count: accepted.length,
      source_uri: p.upload.filename,
      mime_type: p.upload.mime ?? null,
      ...(prepared.persisted ? { file_id: prepared.persisted.row.id } : {}),
      last_refreshed_at: new Date(),
      status: "active",
      last_error: null,
      updated_at: new Date(),
    })
    .where(
      and(
        eq(knowledgeSources.tenant_id, p.tenant_id),
        eq(knowledgeSources.id, p.knowledge_source_id),
      ),
    );

  if (prepared.persisted) {
    await linkKnowledgeFile(tx, {
      tenant_id: p.tenant_id,
      actor_id: p.actor?.id ?? null,
      knowledge_source_id: p.knowledge_source_id,
      slug: prepared.source_slug,
      filename: p.upload.filename,
      mime: p.upload.mime ?? null,
      persisted: prepared.persisted,
    });
  }

  const version = await recordKnowledgeVersion(tx, {
    tenant_id: p.tenant_id,
    knowledge_source_id: p.knowledge_source_id,
    content: prepared.content,
    content_hash: prepared.hash,
    actor: p.actor,
    note: p.restored_from !== undefined ? restoredNote(p.restored_from) : (p.note ?? null),
  });

  await auditAwait(
    {
      tenant_id: p.tenant_id,
      ...auditActor(p.actor),
      action: AuditAction.KNOWLEDGE_SOURCE_INGESTED,
      resource_type: "knowledge_source",
      resource_id: p.knowledge_source_id,
      result: "success",
      before: { version: lockedSource.version },
      after: { version: prepared.hash },
      metadata: {
        slug: lockedSource.slug,
        chunk_count: accepted.length,
        skipped_count: prepared.skipped,
        bytes_total: prepared.total_bytes,
        ...(version !== null ? { content_version: version } : {}),
      },
    },
    tx,
  );
  if (p.restored_from !== undefined) {
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        ...auditActor(p.actor),
        action: AuditAction.KNOWLEDGE_SOURCE_RESTORED,
        resource_type: "knowledge_source",
        resource_id: p.knowledge_source_id,
        result: "success",
        metadata: {
          slug: lockedSource.slug,
          restored_from: p.restored_from,
          new_version: version,
        },
      },
      tx,
    );
  }
  await knowledgeSourceChanged(tx, p.tenant_id, p.knowledge_source_id);
  return { version };
}

export async function ingestKnowledgeSource(
  p: IngestKnowledgeSourceParams,
  exec?: Executor,
): Promise<KnowledgeIngestResult> {
  const db = exec ?? getDb();
  const prepared = await prepareKnowledgeIngest(p, db);
  const applied = await (db as Db).transaction((tx) => applyKnowledgeIngest(tx, p, prepared));

  log.knowledge.ingested({
    knowledge_source_id: p.knowledge_source_id,
    tenant_id: p.tenant_id,
    actor_id: p.actor?.id ?? null,
    format: prepared.format,
    chunk_count: prepared.accepted.length,
    skipped_count: prepared.skipped,
    bytes_total: prepared.total_bytes,
  });
  finishKnowledgeWrite(p.tenant_id, p.knowledge_source_id, db);

  return {
    knowledge_source_id: p.knowledge_source_id,
    ingested_count: prepared.accepted.length,
    skipped_count: prepared.skipped,
    total_bytes: prepared.total_bytes,
    budget_exceeded: false,
    content_version: applied?.version ?? null,
  };
}

const knowledgeSearchCache = new TtlCache<KnowledgeSearchHit[]>({
  maxEntries: 256,
  ttlMs: 60_000,
});

function knowledgeSearchCacheKey(p: SearchKnowledgeParams): string {
  const limit = Math.min(Math.max(1, p.limit ?? 10), 50);
  const normQuery = p.query.trim().toLowerCase();
  const ids = (p.knowledge_source_ids ?? []).slice().sort().join(",");
  const tags = (p.tags ?? []).slice().sort().join(",");
  return [
    p.tenant_id,
    p.scope ?? "",
    p.workflow_id ?? "",
    ids,
    tags,
    String(limit),
    normQuery,
  ].join(":");
}

export function invalidateKnowledgeCache(tenant_id: string): void {
  knowledgeSearchCache.invalidatePrefix(`${tenant_id}:`);
}

export function getKnowledgeSearchCacheStats(): { hits: number; misses: number; size: number } {
  return knowledgeSearchCache.stats();
}

export async function searchKnowledge(
  p: SearchKnowledgeParams,
  exec?: Executor,
): Promise<KnowledgeSearchHit[]> {
  const db = exec ?? getDb();
  const limit = Math.min(Math.max(1, p.limit ?? 10), 50);

  const cacheKey = knowledgeSearchCacheKey(p);
  const cached = knowledgeSearchCache.get(cacheKey);
  if (cached) return cached;

  if (!p.query || p.query.trim().length === 0) return [];

  let scopeFilter = sql`AND ks.deleted_at IS NULL AND ks.status = 'active'`;

  if (p.knowledge_source_ids && p.knowledge_source_ids.length > 0) {
    const ids = p.knowledge_source_ids.map((id) => sql`${id}`);
    scopeFilter = sql`${scopeFilter} AND kc.knowledge_source_id IN (${sql.join(ids, sql`, `)})`;
  } else if (p.workflow_id) {
    scopeFilter = sql`${scopeFilter} AND (ks.scope = 'global' OR (ks.scope = 'workflow' AND ks.workflow_id = ${p.workflow_id}))`;
  } else if (p.scope) {
    scopeFilter = sql`${scopeFilter} AND ks.scope = ${p.scope}`;
  }

  if (p.tags && p.tags.length > 0) {
    const tagLiterals = p.tags.map((t) => sql`${t}`);
    scopeFilter = sql`${scopeFilter} AND ks.tags && ARRAY[${sql.join(tagLiterals, sql`, `)}]::text[]`;
  }

  const out = await db.execute(sql`
    SELECT
      kc.id::text AS id,
      kc.knowledge_source_id::text AS knowledge_source_id,
      ks.name AS source_name,
      ks.tags AS source_tags,
      ks.description AS source_description,
      kc.title,
      kc.path,
      COALESCE(ks.last_refreshed_at, ks.updated_at) AS fetched_at,
      ts_headline(
        'english',
        kc.content,
        plainto_tsquery('english', ${p.query}),
        'MaxWords=25, MinWords=5'
      ) AS snippet,
      ts_rank_cd(kc.tsv, plainto_tsquery('english', ${p.query})) AS rank
    FROM knowledge_chunks kc
    JOIN knowledge_sources ks ON ks.id = kc.knowledge_source_id
    WHERE kc.tenant_id = ${p.tenant_id}
      AND kc.tsv @@ plainto_tsquery('english', ${p.query})
      ${scopeFilter}
    ORDER BY rank DESC
    LIMIT ${limit}
  `);

  type Row = {
    id: string;
    knowledge_source_id: string;
    source_name: string;
    source_tags: string[] | null;
    source_description: string | null;
    title: string | null;
    path: string | null;
    snippet: string;
    rank: number | string;
    fetched_at: Date | string | null;
  };

  const hits: KnowledgeSearchHit[] = (out.rows as Row[]).map((r) => ({
    id: r.id,
    knowledge_source_id: r.knowledge_source_id,
    source_name: r.source_name,
    source_tags: r.source_tags ?? [],
    source_description: r.source_description,
    title: r.title,
    path: r.path,
    snippet: r.snippet,
    rank: typeof r.rank === "string" ? parseFloat(r.rank) : r.rank,
    fetched_at:
      r.fetched_at instanceof Date
        ? r.fetched_at.toISOString()
        : typeof r.fetched_at === "string"
          ? r.fetched_at
          : null,
  }));

  const fused = await fuseKnowledgeWithVectors(db, p, hits, scopeFilter, limit);

  log.knowledge.searched({
    tenant_id: p.tenant_id,
    query_length: p.query.length,
    scope: p.scope ?? null,
    workflow_id: p.workflow_id ?? null,
    hit_count: fused.length,
    top_match_id: fused[0]?.id ?? null,
    top_rank: fused[0]?.rank ?? null,
    limit,
  });

  knowledgeSearchCache.set(cacheKey, fused);
  return fused;
}

const KNOWLEDGE_VECTOR_SCAN_CAP = 2000;
async function fuseKnowledgeWithVectors(
  db: Executor,
  p: SearchKnowledgeParams,
  hits: KnowledgeSearchHit[],
  scopeFilter: SQL,
  limit: number,
): Promise<KnowledgeSearchHit[]> {
  if (!(await embeddingsAvailable())) return hits;
  const out = await db.execute(sql`
    SELECT
      kc.id::text AS id,
      kc.knowledge_source_id::text AS knowledge_source_id,
      ks.name AS source_name,
      ks.tags AS source_tags,
      ks.description AS source_description,
      kc.title,
      kc.path,
      COALESCE(ks.last_refreshed_at, ks.updated_at) AS fetched_at,
      kc.content AS content,
      kc.embedding AS embedding
    FROM knowledge_chunks kc
    JOIN knowledge_sources ks ON ks.id = kc.knowledge_source_id
    WHERE kc.tenant_id = ${p.tenant_id}
      AND kc.embedding IS NOT NULL
      ${scopeFilter}
    ORDER BY kc.created_at DESC
    LIMIT ${KNOWLEDGE_VECTOR_SCAN_CAP}
  `);
  type ScopeRow = {
    id: string;
    knowledge_source_id: string;
    source_name: string;
    source_tags: string[] | null;
    source_description: string | null;
    title: string | null;
    path: string | null;
    fetched_at: Date | string | null;
    content: string;
    embedding: number[] | null;
  };
  const scopeRows = (out as unknown as { rows: ScopeRow[] }).rows ?? (out as unknown as ScopeRow[]);
  const scored = await vectorScoreCandidates(
    p.query,
    scopeRows.map((r) => ({ item: r, embedding: r.embedding })),
  );
  if (scored.length === 0) return hits;
  const byId = new Map(hits.map((h) => [h.id, h]));
  const vector = scored.map((s) => {
    const existing = byId.get(s.item.id);
    const hit: KnowledgeSearchHit = existing ?? {
      id: s.item.id,
      knowledge_source_id: s.item.knowledge_source_id,
      source_name: s.item.source_name,
      source_tags: s.item.source_tags ?? [],
      source_description: s.item.source_description,
      title: s.item.title,
      path: s.item.path,
      snippet: s.item.content.slice(0, 200),
      rank: s.cosine,
      fetched_at:
        s.item.fetched_at instanceof Date
          ? s.item.fetched_at.toISOString()
          : typeof s.item.fetched_at === "string"
            ? s.item.fetched_at
            : null,
    };
    return { item: hit, cosine: s.cosine };
  });
  return fuseVectorFirst({ fts: hits, vector, idOf: (h) => h.id, limit });
}
