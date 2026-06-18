// Knowledge Sources service — CRUD, ingest, and search.
//
// Reuses the chunking/dedup pipeline from docs-ingestion (pure functions,
// no table coupling). Persists to knowledge_sources + knowledge_chunks.

import { createHash } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Db, type Executor, getDb } from "../db/client.ts";
import { knowledgeChunks, knowledgeSources } from "../db/schema/knowledge_sources.ts";
import { fingerprintChunks } from "../docs-ingestion/chunker.ts";
import { dedupChunks } from "../docs-ingestion/dedup.ts";
import { invoke } from "../llm/core/invoke.ts";
import { log } from "../logging/logger.ts";
import { instrument } from "../observability/runtime-telemetry.ts";
import { TtlCache } from "../utils/ttl-cache.ts";
import {
  KNOWLEDGE_SOURCE_MAX_BYTES,
  KNOWLEDGE_TENANT_MAX_BYTES,
  KnowledgeBudgetExceededError,
} from "./budgets.ts";
import { detectFormat, parseFileToChunks } from "./parsers.ts";
import type {
  AnalyzeKnowledgeSourceParams,
  CreateKnowledgeSourceParams,
  IngestKnowledgeSourceParams,
  KnowledgeIngestResult,
  KnowledgeSearchHit,
  KnowledgeSourceView,
  ListKnowledgeSourcesParams,
  SearchKnowledgeParams,
  UpdateKnowledgeSourceParams,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 100);
}

// REPLACE-semantics tag normalizer: trims, drops empties, dedupes
// case-insensitively (keeping first-seen casing), and caps to 20. This
// is the single guard against the array-doubling class of bug — tags are
// always set to a deduped replacement set, never concatenated.
function dedupeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag.slice(0, 40));
    if (out.length >= 20) break;
  }
  return out;
}

function toView(row: typeof knowledgeSources.$inferSelect): KnowledgeSourceView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    tags: row.tags,
    scope: row.scope,
    workflow_id: row.workflow_id,
    status: row.status,
    last_error: row.last_error,
    source_type: row.source_type,
    source_uri: row.source_uri,
    mime_type: row.mime_type,
    version: row.version,
    bytes_total: row.bytes_total,
    chunk_count: row.chunk_count,
    refresh_strategy: row.refresh_strategy,
    refresh_cron: row.refresh_cron,
    last_refreshed_at: row.last_refreshed_at?.toISOString() ?? null,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export async function createKnowledgeSource(
  p: CreateKnowledgeSourceParams,
  exec?: Executor,
): Promise<KnowledgeSourceView> {
  const db = exec ?? getDb();

  // Validate scope constraints
  if (p.input.scope === "workflow" && !p.input.workflow_id) {
    throw new Error("workflow_id is required when scope is 'workflow'");
  }

  const content =
    typeof p.upload.buffer === "string"
      ? p.upload.buffer
      : new TextDecoder().decode(p.upload.buffer);

  const byteSize = Buffer.byteLength(content, "utf8");
  if (byteSize > KNOWLEDGE_SOURCE_MAX_BYTES) {
    throw new KnowledgeBudgetExceededError(
      `File exceeds maximum size of ${KNOWLEDGE_SOURCE_MAX_BYTES} bytes`,
      byteSize,
      KNOWLEDGE_SOURCE_MAX_BYTES,
    );
  }

  const slug = p.input.slug ?? toSlug(p.input.name);
  const version = createHash("sha256").update(content).digest("hex").slice(0, 32);
  const format = detectFormat(p.upload.filename, p.upload.mime);

  // Parse → chunk → fingerprint → dedup (before transaction — pure CPU work)
  const rawChunks = parseFileToChunks(content, p.upload.filename, format);
  const fingerprinted = fingerprintChunks(rawChunks);
  const { accepted, skipped } = dedupChunks(fingerprinted);

  const totalBytes = accepted.reduce((s, c) => s + c.byte_size, 0);

  return await (db as Db).transaction(async (tx) => {
    // Check tenant-level budget INSIDE transaction to prevent race conditions
    // where concurrent inserts both pass the check.
    const tenantUsage = await tx
      .select({ total: sql<number>`coalesce(sum(${knowledgeSources.bytes_total}), 0)` })
      .from(knowledgeSources)
      .where(and(eq(knowledgeSources.tenant_id, p.tenant_id), isNull(knowledgeSources.deleted_at)));
    const currentBytes = Number(tenantUsage[0]?.total ?? 0);
    if (currentBytes + totalBytes > KNOWLEDGE_TENANT_MAX_BYTES) {
      throw new KnowledgeBudgetExceededError(
        `Tenant knowledge budget exceeded (${currentBytes} + ${totalBytes} > ${KNOWLEDGE_TENANT_MAX_BYTES})`,
        currentBytes + totalBytes,
        KNOWLEDGE_TENANT_MAX_BYTES,
      );
    }

    const [row] = await tx
      .insert(knowledgeSources)
      .values({
        tenant_id: p.tenant_id,
        name: p.input.name,
        slug,
        description: p.input.description ?? null,
        tags: dedupeTags(p.input.tags ?? []),
        scope: p.input.scope ?? "global",
        workflow_id: p.input.workflow_id ?? null,
        status: "active",
        source_type: p.source_type_override ?? "file_upload",
        source_uri: p.source_uri_override ?? p.upload.filename,
        mime_type: p.upload.mime ?? null,
        version,
        bytes_total: totalBytes,
        chunk_count: accepted.length,
        refresh_strategy: p.input.refresh_strategy ?? "manual",
        refresh_cron: p.input.refresh_cron ?? null,
      })
      .returning();

    assertInsertRow(row, "knowledge_sources");

    // Insert chunks
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

    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.KNOWLEDGE_SOURCE_CREATED,
        resource_type: "knowledge_source",
        resource_id: row.id,
        result: "success",
        metadata: {
          slug,
          scope: p.input.scope ?? "global",
          chunk_count: accepted.length,
          skipped_count: skipped,
          bytes_total: totalBytes,
          source_uri: p.source_uri_override ?? p.upload.filename,
        },
      },
      tx,
    );

    invalidateKnowledgeCache(p.tenant_id);
    return toView(row);
  });
}

export async function listKnowledgeSources(
  p: ListKnowledgeSourcesParams,
  exec?: Executor,
): Promise<KnowledgeSourceView[]> {
  const db = exec ?? getDb();
  const limit = Math.min(Math.max(1, p.limit ?? 50), 500);
  const offset = Math.max(0, p.offset ?? 0);

  const tenantConds = [
    eq(knowledgeSources.tenant_id, p.tenant_id),
    isNull(knowledgeSources.deleted_at),
  ];
  if (p.scope) tenantConds.push(eq(knowledgeSources.scope, p.scope));
  if (p.workflow_id) tenantConds.push(eq(knowledgeSources.workflow_id, p.workflow_id));
  if (p.status) tenantConds.push(eq(knowledgeSources.status, p.status));

  const rows = await db
    .select()
    .from(knowledgeSources)
    .where(and(...tenantConds))
    .orderBy(desc(knowledgeSources.created_at))
    .limit(limit)
    .offset(offset);

  return rows.map(toView);
}

export async function getKnowledgeSource(
  tenant_id: string,
  id: string,
  exec?: Executor,
): Promise<KnowledgeSourceView | null> {
  const db = exec ?? getDb();
  const rows = await db
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
  return rows[0] ? toView(rows[0]) : null;
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
    const before = toView(existing[0]);

    // Validate scope+workflow_id constraint
    const effectiveScope = p.patch.scope ?? existing[0].scope;
    const effectiveWorkflowId =
      p.patch.workflow_id !== undefined ? p.patch.workflow_id : existing[0].workflow_id;
    if (effectiveScope === "workflow" && !effectiveWorkflowId) {
      throw new Error("workflow_id is required when scope is 'workflow'");
    }

    const updates: Record<string, unknown> = { updated_at: new Date() };
    if (p.patch.name !== undefined) updates.name = p.patch.name;
    if (p.patch.description !== undefined) updates.description = p.patch.description;
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
        after: toView(updated),
        metadata: {},
      },
      tx,
    );

    return toView(updated);
  });
}

// ---------------------------------------------------------------------------
// Analyze (LLM enrichment — best-effort, interactive call sites only)
// ---------------------------------------------------------------------------

// Token-budget the analysis sample to ~6–8k tokens (≈4 chars/token → ~28k
// chars) so a large source never blows the enrichment budget.
const ANALYZE_SAMPLE_MAX_CHARS = 28_000;

const AnalysisSchema = z.object({
  description: z.string().min(1).max(2000),
  tags: z.array(z.string().min(1).max(40)).min(1).max(8),
});

/**
 * Enrich a Knowledge Source's metadata with an LLM-generated description
 * and topical tags. NEVER renames `name`/`slug` (churns the unique slug
 * index and breaks references). The `description` is overwritten only when
 * currently null OR `force` is set; `tags` are always set to a deduped
 * REPLACEMENT set (never concatenated).
 *
 * The LLM call runs OUTSIDE the DB transaction. Callers at the interactive
 * upload sites wrap this in best-effort try/catch — a failed analysis must
 * never fail the upload. Returns the updated view, or `null` if the source
 * does not exist.
 */
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

  // Load the first chunks in ordinal order, token-bounded.
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
    // Nothing to analyze (e.g. a source with no chunks). Leave it as-is.
    return toView(source);
  }

  const prompt = [
    `You are cataloguing an enterprise Knowledge Source named "${source.name}".`,
    "Write a concise description (1-3 sentences, max 2000 characters) summarising what",
    "this source covers and when an operator or AI agent would consult it, plus 3-8 short",
    "lowercase topical tags for routing and filtering (single words or short phrases, e.g.",
    '"billing", "oauth", "compliance"). Do not restate the source name as a tag.',
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
    // Model returned no structured object — leave the source un-enriched.
    return toView(source);
  }

  const nextTags = dedupeTags(analysis.tags);
  const overwriteDescription = source.description === null || p.force === true;

  return await (db as Db).transaction(async (tx) => {
    const updates: Record<string, unknown> = {
      tags: nextTags,
      updated_at: new Date(),
    };
    if (overwriteDescription) updates.description = analysis.description;

    const [updated] = await tx
      .update(knowledgeSources)
      .set(updates)
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
          description_updated: overwriteDescription,
          model_used: result.model_used,
          force: p.force === true,
        },
      },
      tx,
    );

    invalidateKnowledgeCache(p.tenant_id);
    return toView(updated);
  });
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

    invalidateKnowledgeCache(tenant_id);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Ingest (re-ingest / refresh)
// ---------------------------------------------------------------------------

export async function ingestKnowledgeSource(
  p: IngestKnowledgeSourceParams,
  exec?: Executor,
): Promise<KnowledgeIngestResult> {
  const db = exec ?? getDb();

  const content =
    typeof p.upload.buffer === "string"
      ? p.upload.buffer
      : new TextDecoder().decode(p.upload.buffer);

  const byteSize = Buffer.byteLength(content, "utf8");
  if (byteSize > KNOWLEDGE_SOURCE_MAX_BYTES) {
    throw new KnowledgeBudgetExceededError(
      `File exceeds maximum size of ${KNOWLEDGE_SOURCE_MAX_BYTES} bytes`,
      byteSize,
      KNOWLEDGE_SOURCE_MAX_BYTES,
    );
  }

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
    fn: () => parseFileToChunks(content, p.upload.filename, format),
  });
  const fingerprinted = fingerprintChunks(rawChunks);
  const { accepted, skipped } = dedupChunks(fingerprinted);

  const totalBytes = accepted.reduce((s, c) => s + c.byte_size, 0);
  const version = createHash("sha256").update(content).digest("hex").slice(0, 32);

  await (db as Db).transaction(async (tx) => {
    // Delete old chunks
    await tx
      .delete(knowledgeChunks)
      .where(eq(knowledgeChunks.knowledge_source_id, p.knowledge_source_id));

    // Insert new chunks
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

    // Update source metadata
    await tx
      .update(knowledgeSources)
      .set({
        version,
        bytes_total: totalBytes,
        chunk_count: accepted.length,
        source_uri: p.upload.filename,
        mime_type: p.upload.mime ?? null,
        last_refreshed_at: new Date(),
        status: "active",
        last_error: null,
        updated_at: new Date(),
      })
      .where(eq(knowledgeSources.id, p.knowledge_source_id));

    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id,
        action: AuditAction.KNOWLEDGE_SOURCE_INGESTED,
        resource_type: "knowledge_source",
        resource_id: p.knowledge_source_id,
        result: "success",
        metadata: {
          chunk_count: accepted.length,
          skipped_count: skipped,
          bytes_total: totalBytes,
        },
      },
      tx,
    );
  });

  log.knowledge.ingested({
    knowledge_source_id: p.knowledge_source_id,
    tenant_id: p.tenant_id,
    actor_id: p.actor_id,
    format,
    chunk_count: accepted.length,
    skipped_count: skipped,
    bytes_total: totalBytes,
  });

  invalidateKnowledgeCache(p.tenant_id);

  return {
    knowledge_source_id: p.knowledge_source_id,
    ingested_count: accepted.length,
    skipped_count: skipped,
    total_bytes: totalBytes,
    budget_exceeded: false,
  };
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

// In-memory cache for repeated FTS lookups within a conversation turn.
// Scopes to (tenant, scope, workflow, ids?, normalized query, limit) so
// cache poisoning across tenants is impossible. TTL 60s, cap 256 keys.
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

  // Always cache; HTTP routes and tools pass a request-scoped executor
  // but the underlying reads are stable for a 60s TTL.
  const cacheKey = knowledgeSearchCacheKey(p);
  const cached = knowledgeSearchCache.get(cacheKey);
  if (cached) return cached;

  if (!p.query || p.query.trim().length === 0) return [];

  // Build WHERE conditions dynamically. Always filter by tenant and active
  // sources (join via knowledge_source_id → knowledge_sources.status).
  // When workflow_id is provided, include both global and workflow-scoped.
  // When knowledge_source_ids is provided, filter to those specific sources.

  let scopeFilter = sql`AND ks.deleted_at IS NULL AND ks.status = 'active'`;

  if (p.knowledge_source_ids && p.knowledge_source_ids.length > 0) {
    const ids = p.knowledge_source_ids.map((id) => sql`${id}`);
    scopeFilter = sql`${scopeFilter} AND kc.knowledge_source_id IN (${sql.join(ids, sql`, `)})`;
  } else if (p.workflow_id) {
    scopeFilter = sql`${scopeFilter} AND (ks.scope = 'global' OR (ks.scope = 'workflow' AND ks.workflow_id = ${p.workflow_id}))`;
  } else if (p.scope) {
    scopeFilter = sql`${scopeFilter} AND ks.scope = ${p.scope}`;
  }

  // Tag filter rides inside the `kc.tenant_id = ${p.tenant_id}` scope below,
  // so it can only ever narrow results within the tenant — never widen
  // across tenants. `&&` is the GIN-indexed array-overlap operator.
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

  log.knowledge.searched({
    tenant_id: p.tenant_id,
    query_length: p.query.length,
    scope: p.scope ?? null,
    workflow_id: p.workflow_id ?? null,
    hit_count: hits.length,
    limit,
  });

  knowledgeSearchCache.set(cacheKey, hits);
  return hits;
}
