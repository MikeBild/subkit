import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { humanMetadataWrite, metadataChange } from "../api/catalog-metadata.ts";
import { type Actor, auditActor } from "../audit/actor.ts";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { lockCatalogVocabulary } from "../db/catalog-vocabulary.ts";
import type { Db, Executor } from "../db/client.ts";
import { knowledgeChunks, knowledgeSources } from "../db/schema/knowledge_sources.ts";
import { retryTransient } from "../db/transient.ts";
import { fingerprintChunks } from "../docs-ingestion/chunker.ts";
import { dedupChunks } from "../docs-ingestion/dedup.ts";
import type { FingerprintedChunk } from "../docs-ingestion/types.ts";
import { backfillEmbeddings } from "../embeddings/backfill.ts";
import { embeddingsAvailable } from "../embeddings/local-provider.ts";
import { withTenantWork } from "../execution/index.ts";
import type { PersistInlineUploadResult } from "../files/persist-inline-upload.ts";
import { assertTenantActive, lockActiveTenant } from "../identity/index.ts";
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
import {
  isKnowledgeSlugViolation,
  KnowledgeSourceAddressConflictError,
  KnowledgeSourceAddressReadOnlyError,
  KnowledgeSourceSlugTakenError,
  KnowledgeVersionAlreadyCurrentError,
  KnowledgeVersionConflictError,
} from "./errors.ts";
import {
  cleanupPersistedKnowledgeFile,
  linkKnowledgeFile,
  persistKnowledgeFile,
} from "./file-persist.ts";
import { detectFormat, parseFileToChunks } from "./parsers.ts";
import { domainTaggedSourceIds, runKnowledgeFts } from "./search-fts.ts";
import { fuseKnowledgeWithVectors } from "./search-vectors.ts";
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

function knowledgeAuditActor(
  actor: Actor | { kind: "unknown" } | null | undefined,
  legacyActorId: string | null,
) {
  if (actor?.kind === "unknown") return { actor_type: "unknown" as const, actor_id: null };
  if (actor) return auditActor(actor);
  if (legacyActorId) return { actor_type: "unknown" as const, actor_id: null };
  return auditActor(null);
}

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
    await withTenantWork(tenant_id, async () => {
      await assertTenantActive(tenant_id, db);
      if (!(await embeddingsAvailable())) return;
      const result = await backfillEmbeddings({ tenant_id, knowledge_source_id }, db);
      if (result.knowledge.embedded > 0) invalidateKnowledgeCache(tenant_id);
    });
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

type ParsedKnowledgeCreate = Omit<PreparedKnowledgeCreate, "persisted">;

function parseKnowledgeCreate(p: CreateKnowledgeSourceParams): ParsedKnowledgeCreate {
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
    content: knowledgeVersionContent({
      source_type,
      upload: p.upload,
      text: content,
      parsed_chunks: p.parsed_chunks,
    }),
  };
}

export async function prepareKnowledgeCreate(
  p: CreateKnowledgeSourceParams,
  db: Executor,
): Promise<PreparedKnowledgeCreate> {
  await lockCatalogVocabulary(db, p.tenant_id);
  await lockActiveTenant(p.tenant_id, db);
  const parsed = parseKnowledgeCreate(p);
  return {
    ...parsed,
    persisted: parsed.source_type === "url" ? null : await persistKnowledgeFile(db, p),
  };
}

export async function applyKnowledgeCreate(
  tx: Executor,
  p: CreateKnowledgeSourceParams,
  prepared: PreparedKnowledgeCreate,
): Promise<KnowledgeSourceView> {
  await lockCatalogVocabulary(tx, p.tenant_id);
  await lockActiveTenant(p.tenant_id, tx);
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
      actor: p.actor ?? null,
      knowledge_source_id: row.id,
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

const KNOWLEDGE_WRITE_RETRY = {
  tries: 5,
  startMs: 50,
  maxMs: 1_000,
  label: "knowledge_write",
} as const;

export async function createKnowledgeSource(
  p: CreateKnowledgeSourceParams,
  db: Executor,
): Promise<KnowledgeSourceView> {
  return withTenantWork(p.tenant_id, async () => {
    await assertTenantActive(p.tenant_id, db);
    const parsed = parseKnowledgeCreate(p);
    let persisted: PersistInlineUploadResult | null = null;
    let created: KnowledgeSourceView;
    try {
      persisted = parsed.source_type === "url" ? null : await persistKnowledgeFile(db, p);
      const prepared: PreparedKnowledgeCreate = { ...parsed, persisted };
      created = await retryTransient(
        () => (db as Db).transaction((tx) => applyKnowledgeCreate(tx, p, prepared)),
        KNOWLEDGE_WRITE_RETRY,
      );
    } catch (error) {
      await cleanupPersistedKnowledgeFile(db, persisted);
      if (isKnowledgeSlugViolation(error)) throw new KnowledgeSourceSlugTakenError(parsed.slug);
      throw error;
    }
    finishKnowledgeWrite(p.tenant_id, created.id, db);
    return created;
  });
}

export async function getKnowledgeSourceBySlug(
  tenant_id: string,
  slug: string,
  db: Executor,
): Promise<KnowledgeSourceView | null> {
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
  db: Executor,
): Promise<KnowledgeSourceView | null> {
  return await (db as Db).transaction(async (tx) => {
    await lockCatalogVocabulary(tx, p.tenant_id);
    await lockActiveTenant(p.tenant_id, tx);
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
      .limit(1)
      .for("update");

    if (!existing[0]) return null;
    const before = knowledgeSourceRowToView(existing[0]);
    if (p.patch.source_uri !== undefined && existing[0].source_type !== "url") {
      throw new KnowledgeSourceAddressReadOnlyError();
    }

    const effectiveScope = p.patch.scope ?? existing[0].scope;
    const effectiveWorkflowId =
      p.patch.workflow_id !== undefined ? p.patch.workflow_id : existing[0].workflow_id;
    if (effectiveScope === "workflow" && !effectiveWorkflowId) {
      throw new Error("workflow_id is required when scope is 'workflow'");
    }

    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (p.patch.name !== undefined) updates.name = p.patch.name;
    if (p.patch.source_uri !== undefined) updates.source_uri = p.patch.source_uri;
    Object.assign(
      updates,
      metadataChange(existing[0], {
        ...(p.patch.description !== undefined ? { description: p.patch.description } : {}),
        ...(p.patch.accept_description !== undefined
          ? { accept_description: p.patch.accept_description }
          : {}),
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
      .where(and(eq(knowledgeSources.tenant_id, p.tenant_id), eq(knowledgeSources.id, p.id)))
      .returning();

    if (!updated) return null;

    await auditAwait(
      {
        tenant_id: p.tenant_id,
        ...knowledgeAuditActor(p.actor, p.actor_id),
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
  db: Executor,
): Promise<KnowledgeSourceView | null> {
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
        ...knowledgeAuditActor(p.actor, p.actor_id),
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
  db: Executor,
  actor?: Actor | { kind: "unknown" } | null,
): Promise<boolean> {
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
        ...knowledgeAuditActor(actor, actor_id),
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
  content: KnowledgeVersionContent;
}

export interface AppliedKnowledgeIngest {
  version: number | null;
}

type ParsedKnowledgeIngest = Omit<PreparedKnowledgeIngest, "persisted" | "content"> & {
  text: string;
};

async function parseKnowledgeIngest(
  p: IngestKnowledgeSourceParams,
): Promise<ParsedKnowledgeIngest> {
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
  return {
    format,
    hash: knowledgeContentHash(content),
    accepted,
    skipped,
    total_bytes: accepted.reduce((s, c) => s + c.byte_size, 0),
    text: content,
  };
}

async function knowledgeIngestSourceType(
  db: Executor,
  p: IngestKnowledgeSourceParams,
): Promise<string | null> {
  const [row] = await db
    .select({ source_type: knowledgeSources.source_type })
    .from(knowledgeSources)
    .where(
      and(
        eq(knowledgeSources.tenant_id, p.tenant_id),
        eq(knowledgeSources.id, p.knowledge_source_id),
        isNull(knowledgeSources.deleted_at),
      ),
    )
    .limit(1);
  return row?.source_type ?? null;
}

async function completeKnowledgeIngest(
  db: Executor,
  p: IngestKnowledgeSourceParams,
  parsed: ParsedKnowledgeIngest,
  sourceType: string | null,
): Promise<PreparedKnowledgeIngest> {
  const { text, ...rest } = parsed;
  const keepsFile = sourceType !== null && sourceType !== "url";
  return {
    ...rest,
    persisted: keepsFile ? await persistKnowledgeFile(db, p) : null,
    content: knowledgeVersionContent({
      source_type: sourceType ?? "file_upload",
      upload: p.upload,
      text,
      parsed_chunks: p.parsed_chunks,
    }),
  };
}

export async function prepareKnowledgeIngest(
  p: IngestKnowledgeSourceParams,
  db: Executor,
): Promise<PreparedKnowledgeIngest> {
  await lockCatalogVocabulary(db, p.tenant_id);
  await lockActiveTenant(p.tenant_id, db);
  const parsed = await parseKnowledgeIngest(p);
  return completeKnowledgeIngest(db, p, parsed, await knowledgeIngestSourceType(db, p));
}

export async function applyKnowledgeIngest(
  tx: Executor,
  p: IngestKnowledgeSourceParams,
  prepared: PreparedKnowledgeIngest,
): Promise<AppliedKnowledgeIngest | null> {
  await lockCatalogVocabulary(tx, p.tenant_id);
  await lockActiveTenant(p.tenant_id, tx);
  const { accepted } = prepared;
  const [lockedSource] = await tx
    .select({
      version: knowledgeSources.version,
      slug: knowledgeSources.slug,
      source_uri: knowledgeSources.source_uri,
    })
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
  if (p.expected_source_uri !== undefined && lockedSource.source_uri !== p.expected_source_uri) {
    throw new KnowledgeSourceAddressConflictError();
  }
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
      actor: p.actor ?? null,
      knowledge_source_id: p.knowledge_source_id,
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
  db: Executor,
): Promise<KnowledgeIngestResult> {
  return withTenantWork(p.tenant_id, async () => {
    await assertTenantActive(p.tenant_id, db);
    const parsed = await parseKnowledgeIngest(p);
    const sourceType = await knowledgeIngestSourceType(db, p);
    let prepared: PreparedKnowledgeIngest | null = null;
    let applied: AppliedKnowledgeIngest | null;
    try {
      prepared = await completeKnowledgeIngest(db, p, parsed, sourceType);
      const ready = prepared;
      applied = await retryTransient(
        () => (db as Db).transaction((tx) => applyKnowledgeIngest(tx, p, ready)),
        KNOWLEDGE_WRITE_RETRY,
      );
    } catch (error) {
      await cleanupPersistedKnowledgeFile(db, prepared?.persisted ?? null);
      throw error;
    }
    if (!applied) await cleanupPersistedKnowledgeFile(db, prepared.persisted);

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
  });
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
  db: Executor,
): Promise<KnowledgeSearchHit[]> {
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

  const allTermsQuery = sql`plainto_tsquery('english', ${p.query})`;
  let hits = await runKnowledgeFts(db, p.tenant_id, allTermsQuery, scopeFilter, limit, []);
  if (hits.length === 0) {
    const anyTermQuery = sql`regexp_replace(${allTermsQuery}::text, ' & ', ' | ', 'g')::tsquery`;
    const domainIds = await domainTaggedSourceIds(db, p.tenant_id, anyTermQuery);
    hits = await runKnowledgeFts(db, p.tenant_id, anyTermQuery, scopeFilter, limit, domainIds);
  }

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
