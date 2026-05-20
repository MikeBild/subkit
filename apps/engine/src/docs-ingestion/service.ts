// Documentation ingestion orchestrator.
//
// Flow: fetch → normalize → chunk+fingerprint → dedup → persist.
// Every ingest writes one row to `connector_documents` and N rows to
// `connector_document_chunks`, with total + per-chunk bytes enforced
// against the canonical budget table (10 MB / 3 MB / 20 links / 100
// specs / 25 concurrent). Budgets are soft-stop: if the total cap
// trips partway through, we commit the rows we already accepted and
// mark `budget_exceeded: true` in the result.
//
// The service is called from two places:
//   1. The `POST /v1/connectors/:id/docs/ingest` route (synchronous).
//   2. The `connector.ingest-docs` pg-boss handler (background refresh).
// Both paths land in `ingestDocs(...)`.

import { createHash } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { auditAwait } from "../audit/audit.ts";
import { sanitizeForAudit } from "../audit/sanitize.ts";
import { AuditAction } from "../audit/types.ts";
import type { ConnectorTemplate } from "../connectors/templates.ts";
import { assertInsertRow } from "../db/assert-insert.ts";
import { type Db, getDb } from "../db/client.ts";
import { connectorDocumentChunks, connectorDocuments, connectors } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import { TtlCache } from "../utils/ttl-cache.ts";
import {
  canConsumeBytes,
  createBudgetState,
  markBudgetExceeded,
  PageTooLargeError,
  recordBudgetWarning,
} from "./budgets.ts";
import { cascadeIngest } from "./cascade.ts";
import { byteLen, fingerprintChunks } from "./chunker.ts";
import { dedupChunks } from "./dedup.ts";
import { BinaryParseError } from "./parsers/index.ts";
import { rerankSearchHits, type SearchHitMatchType } from "./search-ranking.ts";
import { type FileUploadInput, ingestFileUpload } from "./sources/file-upload.ts";
import { chunkGraphQLSchema, ingestGraphQLIntrospection } from "./sources/graphql.ts";
import { ingestLlmsTxt } from "./sources/llms-txt.ts";
import { ingestMarkdown } from "./sources/markdown.ts";
import { chunkOpenAPI, ingestOpenAPIUrl } from "./sources/openapi.ts";
import { ingestPostgresInformationSchema } from "./sources/postgres.ts";
import type { DocSourceType, IngestResult, IngestSourceInput, RawChunk } from "./types.ts";
import { NotImplementedError } from "./types.ts";

type Executor = Db | Parameters<Parameters<Db["transaction"]>[0]>[0];

export interface IngestParams {
  tenant_id: string;
  connector_id: string;
  input: IngestSourceInput;
  actor_id?: string | null;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

function parseInlineOpenApiChunks(content: string): RawChunk[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `inline openapi parse failed (JSON only): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return chunkOpenAPI(parsed);
}

function parseInlineGraphQlChunks(content: string): RawChunk[] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch (err) {
    throw new Error(
      `inline graphql introspection parse failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const envelope = parsed.data as { __schema?: unknown } | undefined;
  const schema = (envelope?.__schema ?? parsed.__schema ?? parsed) as Parameters<
    typeof chunkGraphQLSchema
  >[0];
  return chunkGraphQLSchema(schema);
}

export async function ingestDocs(p: IngestParams, exec?: Executor): Promise<IngestResult> {
  const db = exec ?? getDb();
  const fetchImpl = p.fetchImpl ?? fetch;
  logger.info({
    module: "docs",
    action: "ingest.started",
    msg: "doc ingest started",
    tenant_id: p.tenant_id,
    connector_id: p.connector_id,
    source_type: p.input.source_type,
    url: p.input.url ?? null,
  });

  const state = createBudgetState();
  let uri = p.input.url ?? "inline";
  let rawChunks: RawChunk[] = [];
  // Cascade may override the declared source_type with whichever strategy
  // actually produced content, so downstream rows tag correctly. The DB
  // enum does not carry "cascade" — by the time we write, one of the
  // concrete source kinds is stored. "cascade" is a request-time intent.
  type PersistedDocSourceType = Exclude<DocSourceType, "cascade">;
  let persistedSourceType: PersistedDocSourceType =
    p.input.source_type === "cascade" ? "openapi" : p.input.source_type;
  try {
    switch (p.input.source_type) {
      case "openapi": {
        if (p.input.content !== undefined) {
          uri = p.input.url ?? "inline:openapi";
          rawChunks = parseInlineOpenApiChunks(p.input.content);
        } else {
          if (!p.input.url) throw new Error("openapi source requires url");
          const got = await ingestOpenAPIUrl(p.input.url, state, fetchImpl);
          uri = got.uri;
          rawChunks = got.chunks;
        }
        break;
      }
      case "markdown": {
        const mdInput: { url?: string; content?: string } = {};
        if (p.input.url !== undefined) mdInput.url = p.input.url;
        if (p.input.content !== undefined) mdInput.content = p.input.content;
        const got = await ingestMarkdown(mdInput, state, fetchImpl);
        uri = got.uri;
        rawChunks = got.chunks;
        break;
      }
      case "llms_txt": {
        if (!p.input.url) throw new Error("llms_txt source requires url");
        const got = await ingestLlmsTxt(p.input.url, state, fetchImpl);
        uri = got.uri;
        rawChunks = got.chunks;
        break;
      }
      case "graphql": {
        if (p.input.content !== undefined) {
          uri = p.input.url ?? "inline:graphql";
          rawChunks = parseInlineGraphQlChunks(p.input.content);
        } else {
          if (!p.input.url) throw new Error("graphql source requires url");
          const got = await ingestGraphQLIntrospection(p.input.url, state, fetchImpl);
          uri = got.uri;
          rawChunks = got.chunks;
        }
        break;
      }
      case "postgres": {
        // The postgres source reads `information_schema` over the
        // connector's own DSN. The orchestrator looks up the connector
        // and forwards the dsn through `p.input.url` since it doubles as
        // an opaque source identifier.
        if (!p.input.url) throw new Error("postgres source requires url (dsn)");
        const params: Parameters<typeof ingestPostgresInformationSchema>[0] = {
          dsn: p.input.url,
        };
        if (p.input.schemas) params.schemas = p.input.schemas;
        const got = await ingestPostgresInformationSchema(params, state);
        uri = got.uri;
        rawChunks = got.chunks;
        break;
      }
      case "file_upload": {
        if (!p.input.upload) throw new Error("file_upload source requires upload");
        const fileInput: FileUploadInput = { buffer: p.input.upload.buffer };
        if (p.input.upload.filename) fileInput.filename = p.input.upload.filename;
        if (p.input.upload.mime) fileInput.mime = p.input.upload.mime;
        const got = await ingestFileUpload(fileInput);
        uri = got.uri;
        rawChunks = got.chunks;
        break;
      }
      case "cascade": {
        if (!p.input.url) throw new Error("cascade source requires url");
        const got = await cascadeIngest({
          base_url: p.input.url,
          fetchImpl,
          state,
        });
        if (!got.winning_source || got.winning_source === "cascade") {
          throw new Error(
            `cascade failed: tried ${got.attempts.length} probes across openapi/graphql/llms_txt/markdown, none returned content`,
          );
        }
        uri = got.source_uri ?? p.input.url;
        rawChunks = got.chunks;
        persistedSourceType = got.winning_source as PersistedDocSourceType;
        logger.info({
          module: "docs",
          action: "ingest.cascade",
          msg: "cascade picked a winning source",
          winning_source: got.winning_source,
          probes_tried: got.attempts.length,
          source_uri: uri,
        });
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({
      module: "docs",
      action: "ingest.failed",
      msg: "doc ingest failed",
      tenant_id: p.tenant_id,
      connector_id: p.connector_id,
      source_type: p.input.source_type,
      error: msg,
    });
    // Audit binary parse failures on the file-upload source. The HTTP
    // `/v1/extract` surface already writes `DATA_EXPORTED + error +
    // parse_failed`; this branch closes the asymmetry for tenants
    // uploading via the connector_docs path (e.g. queue handlers,
    // batch ingest). Other failure classes keep their pre-existing
    // logger.error-only behaviour to avoid audit-log volume blowup
    // on a single bad URL.
    if (err instanceof BinaryParseError) {
      await auditAwait(
        {
          tenant_id: p.tenant_id,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.CONNECTOR_DOCS_INGESTED,
          resource_type: "connector",
          resource_id: p.connector_id,
          result: "error",
          reason: "parse_failed",
          metadata: {
            source_type: p.input.source_type,
            format: err.format,
            error: sanitizeForAudit(err.message),
            ...(p.input.upload?.filename
              ? { filename: sanitizeForAudit(p.input.upload.filename) }
              : {}),
          },
        },
        db,
      );
    }
    if (err instanceof PageTooLargeError) {
      throw err;
    }
    throw err;
  }

  // Fingerprint + budget-gated accept + dedup. The chunker raises a
  // budget warning whenever it has to trim a chunk over the per-page
  // 3 MB cap so the orchestrator can record the truncation in the audit
  // metadata.
  const fingerprinted = fingerprintChunks(rawChunks, {
    onTruncate: (msg) => recordBudgetWarning(state, msg),
  });
  const { accepted: dedupedAll, skipped: dedupSkipped } = dedupChunks(fingerprinted);

  const accepted: typeof dedupedAll = [];
  let totalBytes = 0;
  let budgetExceeded = false;
  for (const c of dedupedAll) {
    if (!canConsumeBytes(state, c.byte_size)) {
      markBudgetExceeded(state);
      budgetExceeded = true;
      break;
    }
    accepted.push(c);
    totalBytes += c.byte_size;
  }
  budgetExceeded = budgetExceeded || state.budget_exceeded;

  const version = createHash("sha256")
    .update(`${persistedSourceType}|${uri}|${rawChunks.length}|${totalBytes}`)
    .digest("hex")
    .slice(0, 32);

  // Persist in a single transaction.
  const result: IngestResult = await db.transaction(async (tx) => {
    const [docRow] = await tx
      .insert(connectorDocuments)
      .values({
        tenant_id: p.tenant_id,
        connector_id: p.connector_id,
        source_type: persistedSourceType,
        source_uri: uri,
        version,
        bytes_total: totalBytes,
        chunk_count: accepted.length,
      })
      .returning();
    assertInsertRow(docRow, "connector_documents");

    if (accepted.length > 0) {
      await tx.insert(connectorDocumentChunks).values(
        accepted.map((c, i) => ({
          tenant_id: p.tenant_id,
          connector_id: p.connector_id,
          document_id: docRow.id,
          ordinal: i,
          title: c.title ?? null,
          path: c.path ?? null,
          content: c.content,
          byte_size: c.byte_size,
          fingerprint: c.fingerprint,
        })),
      );
    }

    for (let i = 0; i < accepted.length; i += 1) {
      const c = accepted[i]!;
      logger.debug({
        module: "docs",
        action: "ingest.chunk",
        msg: "doc ingest chunk persisted",
        ordinal: i,
        bytes: c.byte_size,
        dedup_skipped: false,
      });
    }

    // Stamp the connector with the ingest time so the auto-refresh
    // reconciler can compare it against the cron expression.
    await tx
      .update(connectors)
      .set({ last_ingested_at: new Date() })
      .where(eq(connectors.id, p.connector_id));

    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id ?? null,
        action: AuditAction.CONNECTOR_DOCS_INGESTED,
        resource_type: "connector",
        resource_id: p.connector_id,
        result: "success",
        metadata: {
          document_id: docRow.id,
          source_type: persistedSourceType,
          requested_source_type: p.input.source_type,
          source_uri: uri,
          bytes: totalBytes,
          chunks: accepted.length,
          dedup_skipped: dedupSkipped,
          budget_exceeded: budgetExceeded,
          warnings: state.warnings ?? [],
        },
      },
      tx,
    );

    return {
      document_id: docRow.id,
      ingested_count: accepted.length,
      skipped_count: dedupSkipped + (dedupedAll.length - accepted.length),
      total_bytes: totalBytes,
      budget_exceeded: budgetExceeded,
      source_type: persistedSourceType,
      source_uri: uri,
    };
  });

  // Invalidate any cached search results for this connector — the next
  // search must reflect the freshly-ingested chunks, not a stale snapshot.
  invalidateDocsCache(p.tenant_id, p.connector_id);

  logger.info({
    module: "docs",
    action: "ingest.completed",
    msg: "doc ingest completed",
    tenant_id: p.tenant_id,
    connector_id: p.connector_id,
    source_type: persistedSourceType,
    bytes: result.total_bytes,
    chunks: result.ingested_count,
    skipped: result.skipped_count,
    budget_exceeded: result.budget_exceeded,
  });

  return result;
}

export async function ingestTemplateDocsForConnector(
  p: {
    tenant_id: string;
    connector_id: string;
    template: ConnectorTemplate;
    actor_id?: string | null;
    fetchImpl?: typeof fetch;
  },
  exec?: Executor,
): Promise<IngestResult | null> {
  const template = p.template;
  if (template.inline_schema) {
    const input: IngestParams = {
      tenant_id: p.tenant_id,
      connector_id: p.connector_id,
      actor_id: p.actor_id ?? null,
      input: {
        source_type: template.inline_schema.format,
        content: template.inline_schema.content,
        url: `template:${template.slug}:inline-${template.inline_schema.format}`,
      },
    };
    if (p.fetchImpl) input.fetchImpl = p.fetchImpl;
    return await ingestDocs(input, exec);
  }
  if (!template.ingestion_url) return null;
  if (
    template.ingestion_source !== "openapi" &&
    template.ingestion_source !== "markdown" &&
    template.ingestion_source !== "llms_txt" &&
    template.ingestion_source !== "graphql" &&
    template.ingestion_source !== "postgres"
  ) {
    throw new NotImplementedError(
      `template ingestion source ${template.ingestion_source} is unsupported`,
    );
  }
  const input: IngestParams = {
    tenant_id: p.tenant_id,
    connector_id: p.connector_id,
    actor_id: p.actor_id ?? null,
    input: {
      source_type: template.ingestion_source,
      url: template.ingestion_url,
    },
  };
  if (p.fetchImpl) input.fetchImpl = p.fetchImpl;
  return await ingestDocs(input, exec);
}

export interface ListDocsParams {
  tenant_id: string;
  connector_id: string;
}

export async function listDocs(p: ListDocsParams, exec?: Executor) {
  const db = exec ?? getDb();
  const rows = await db
    .select()
    .from(connectorDocuments)
    .where(
      and(
        eq(connectorDocuments.tenant_id, p.tenant_id),
        eq(connectorDocuments.connector_id, p.connector_id),
        isNull(connectorDocuments.deleted_at),
      ),
    )
    .orderBy(desc(connectorDocuments.created_at));
  return rows.map((r) => ({
    id: r.id,
    source_type: r.source_type,
    source_uri: r.source_uri,
    version: r.version,
    bytes_total: r.bytes_total,
    chunk_count: r.chunk_count,
    created_at: r.created_at.toISOString(),
    updated_at: r.updated_at.toISOString(),
  }));
}

export interface DeleteDocParams {
  tenant_id: string;
  connector_id: string;
  document_id: string;
  actor_id?: string | null;
}

export async function deleteDoc(p: DeleteDocParams, exec?: Executor): Promise<boolean> {
  const db = exec ?? getDb();
  return await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(connectorDocuments)
      .where(
        and(
          eq(connectorDocuments.tenant_id, p.tenant_id),
          eq(connectorDocuments.connector_id, p.connector_id),
          eq(connectorDocuments.id, p.document_id),
          isNull(connectorDocuments.deleted_at),
        ),
      )
      .limit(1);
    if (!existing[0]) return false;
    await tx.delete(connectorDocuments).where(eq(connectorDocuments.id, p.document_id));
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        actor_type: p.actor_id ? "user" : "system",
        actor_id: p.actor_id ?? null,
        action: AuditAction.CONNECTOR_DOCS_CLEARED,
        resource_type: "connector",
        resource_id: p.connector_id,
        result: "success",
        metadata: { document_id: p.document_id },
      },
      tx,
    );
    return true;
  });
}

export interface SearchParams {
  tenant_id: string;
  connector_id: string;
  query: string;
  limit?: number;
}

// In-memory cache for repeated FTS lookups. Entries scope to
// (tenant, connector, normalized query, limit) and live for 60s. Cap of
// 256 keeps the cache from drifting unbounded under heavy multitenant
// load. Process-local — no cross-replica coherence.
const searchCache = new TtlCache<SearchHit[]>({ maxEntries: 256, ttlMs: 60_000 });

function searchCacheKey(p: SearchParams): string {
  const limit = Math.min(Math.max(1, p.limit ?? 10), 50);
  const normQuery = p.query.trim().toLowerCase();
  return `${p.tenant_id}:${p.connector_id}:${limit}:${normQuery}`;
}

/** Drop every cached search entry for a connector. Called after ingest. */
export function invalidateDocsCache(tenant_id: string, connector_id: string): void {
  searchCache.invalidatePrefix(`${tenant_id}:${connector_id}:`);
}

/** Test/observability hook — counters for cache hits + size. */
export function getDocsSearchCacheStats(): { hits: number; misses: number; size: number } {
  return searchCache.stats();
}

export interface SearchHit {
  id: string;
  document_id: string;
  title: string | null;
  path: string | null;
  snippet: string;
  rank: number;
  match_type: SearchHitMatchType;
  /** ISO-8601 timestamp of the document's most recent fetch. */
  fetched_at: string | null;
}

export async function searchDocs(p: SearchParams, exec?: Executor): Promise<SearchHit[]> {
  const db = exec ?? getDb();
  const limit = Math.min(Math.max(1, p.limit ?? 10), 50);
  const candidateLimit = Math.min(Math.max(limit * 5, limit), 250);

  // Always cache: HTTP routes and conversation tools pass a request-scoped
  // executor, but reads from connector_document_chunks are stable enough
  // that a 60s TTL with invalidate-on-ingest is the right tradeoff.
  const cacheKey = searchCacheKey(p);
  const cached = searchCache.get(cacheKey);
  if (cached) return cached;
  // Drizzle's `sql` template binds params safely. plainto_tsquery itself
  // normalises the query string so we don't need to escape the content.
  // We JOIN connector_documents so each chunk hit carries the source
  // document's last-fetch timestamp, letting the caller reason about
  // staleness without an extra round-trip.
  const out = await db.execute(sql`
    SELECT
      cdc.id::text AS id,
      cdc.document_id::text AS document_id,
      cdc.title AS title,
      cdc.path AS path,
      cdc.content AS content,
      cd.updated_at AS fetched_at,
      ts_headline(
        'english',
        cdc.content,
        plainto_tsquery('english', ${p.query}),
        'MaxWords=25, MinWords=5'
      ) AS snippet,
      ts_rank_cd(cdc.tsv, plainto_tsquery('english', ${p.query})) AS rank
    FROM connector_document_chunks cdc
    JOIN connector_documents cd ON cd.id = cdc.document_id
    WHERE cdc.tenant_id = ${p.tenant_id}
      AND cdc.connector_id = ${p.connector_id}
      AND cdc.tsv @@ plainto_tsquery('english', ${p.query})
    ORDER BY rank DESC
    LIMIT ${candidateLimit}
  `);
  type Row = {
    id: string;
    document_id: string;
    title: string | null;
    path: string | null;
    content: string;
    snippet: string;
    rank: number | string;
    fetched_at: Date | string | null;
  };
  const rows = (out as unknown as { rows: Row[] }).rows ?? (out as unknown as Row[]);
  const hits = rerankSearchHits(
    p.query,
    (rows as Row[]).map((r) => ({
      id: r.id,
      document_id: r.document_id,
      title: r.title,
      path: r.path,
      content: r.content,
      snippet: r.snippet,
      rank: Number(r.rank),
      fetched_at:
        r.fetched_at instanceof Date
          ? r.fetched_at.toISOString()
          : typeof r.fetched_at === "string"
            ? r.fetched_at
            : null,
    })),
    limit,
  );
  searchCache.set(cacheKey, hits);
  return hits;
}

// Touch byteLen so the linter doesn't flag an unused import — the
// chunker re-exports it but the service used to rely on it directly.
void byteLen;
