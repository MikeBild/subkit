// Knowledge Sources service — CRUD, ingest, and search.
//
// Reuses the chunking/dedup pipeline from docs-ingestion (pure functions,
// no table coupling). Persists to knowledge_sources + knowledge_chunks.

import { createHash } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { AuditAction } from "../audit/types.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Db, getDb } from "../db/client.ts";
import { knowledgeChunks, knowledgeSources } from "../db/schema/knowledge_sources.ts";
import { fingerprintChunks } from "../docs-ingestion/chunker.ts";
import { dedupChunks } from "../docs-ingestion/dedup.ts";
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
  CreateKnowledgeSourceParams,
  IngestKnowledgeSourceParams,
  KnowledgeIngestResult,
  KnowledgeSearchHit,
  KnowledgeSourceView,
  ListKnowledgeSourcesParams,
  SearchKnowledgeParams,
  UpdateKnowledgeSourceParams,
} from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

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

function toView(row: typeof knowledgeSources.$inferSelect): KnowledgeSourceView {
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    scope: row.scope,
    workflow_id: row.workflow_id,
    status: row.status,
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
  return [p.tenant_id, p.scope ?? "", p.workflow_id ?? "", ids, String(limit), normQuery].join(":");
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

  const out = await db.execute(sql`
    SELECT
      kc.id::text AS id,
      kc.knowledge_source_id::text AS knowledge_source_id,
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
    title: string | null;
    path: string | null;
    snippet: string;
    rank: number | string;
    fetched_at: Date | string | null;
  };

  const hits: KnowledgeSearchHit[] = (out.rows as Row[]).map((r) => ({
    id: r.id,
    knowledge_source_id: r.knowledge_source_id,
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
