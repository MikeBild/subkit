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
import { AuditAction } from "../audit/types.ts";
import { type Db, getDb } from "../db/client.ts";
import { connectorDocumentChunks, connectorDocuments, connectors } from "../db/schema/index.ts";
import { logger } from "../logging/logger.ts";
import {
  canConsumeBytes,
  createBudgetState,
  markBudgetExceeded,
  PageTooLargeError,
  recordBudgetWarning,
} from "./budgets.ts";
import { byteLen, fingerprintChunks } from "./chunker.ts";
import { dedupChunks } from "./dedup.ts";
import { type FileUploadInput, ingestFileUpload } from "./sources/file-upload.ts";
import { ingestGraphQLIntrospection } from "./sources/graphql.ts";
import { ingestLlmsTxt } from "./sources/llms-txt.ts";
import { ingestMarkdown } from "./sources/markdown.ts";
import { ingestOpenAPIUrl } from "./sources/openapi.ts";
import { ingestPostgresInformationSchema } from "./sources/postgres.ts";
import type { IngestResult, IngestSourceInput, RawChunk } from "./types.ts";
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

export async function ingestDocs(p: IngestParams, exec?: Executor): Promise<IngestResult> {
  const db = exec ?? getDb();
  const fetchImpl = p.fetchImpl ?? fetch;
  logger.info({
    module: "docs",
    action: "log.docs.ingest.started",
    msg: "doc ingest started",
    tenant_id: p.tenant_id,
    connector_id: p.connector_id,
    source_type: p.input.source_type,
    url: p.input.url ?? null,
  });

  const state = createBudgetState();
  let uri = p.input.url ?? "inline";
  let rawChunks: RawChunk[] = [];
  try {
    switch (p.input.source_type) {
      case "openapi": {
        if (!p.input.url) throw new Error("openapi source requires url");
        const got = await ingestOpenAPIUrl(p.input.url, state, fetchImpl);
        uri = got.uri;
        rawChunks = got.chunks;
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
      case "html": {
        throw new NotImplementedError("html ingestion requires playwright in a later phase");
      }
      case "graphql": {
        if (!p.input.url) throw new Error("graphql source requires url");
        const got = await ingestGraphQLIntrospection(p.input.url, state, fetchImpl);
        uri = got.uri;
        rawChunks = got.chunks;
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
        const got = ingestFileUpload(fileInput);
        uri = got.uri;
        rawChunks = got.chunks;
        break;
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({
      module: "docs",
      action: "log.docs.ingest.failed",
      msg: "doc ingest failed",
      tenant_id: p.tenant_id,
      connector_id: p.connector_id,
      source_type: p.input.source_type,
      error: msg,
    });
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
    .update(`${p.input.source_type}|${uri}|${rawChunks.length}|${totalBytes}`)
    .digest("hex")
    .slice(0, 32);

  // Persist in a single transaction.
  const result: IngestResult = await db.transaction(async (tx) => {
    const [docRow] = await tx
      .insert(connectorDocuments)
      .values({
        tenant_id: p.tenant_id,
        connector_id: p.connector_id,
        source_type: p.input.source_type,
        source_uri: uri,
        version,
        bytes_total: totalBytes,
        chunk_count: accepted.length,
      })
      .returning();
    if (!docRow) throw new Error("connector_documents insert returned no row");

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
        action: "log.docs.ingest.chunk",
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
          source_type: p.input.source_type,
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
      source_type: p.input.source_type,
      source_uri: uri,
    };
  });

  logger.info({
    module: "docs",
    action: "log.docs.ingest.completed",
    msg: "doc ingest completed",
    tenant_id: p.tenant_id,
    connector_id: p.connector_id,
    source_type: p.input.source_type,
    bytes: result.total_bytes,
    chunks: result.ingested_count,
    skipped: result.skipped_count,
    budget_exceeded: result.budget_exceeded,
  });

  return result;
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

export interface SearchHit {
  id: string;
  document_id: string;
  title: string | null;
  path: string | null;
  snippet: string;
  rank: number;
}

export async function searchDocs(p: SearchParams, exec?: Executor): Promise<SearchHit[]> {
  const db = exec ?? getDb();
  const limit = Math.min(Math.max(1, p.limit ?? 10), 50);
  // Drizzle's `sql` template binds params safely. plainto_tsquery itself
  // normalises the query string so we don't need to escape the content.
  const out = await db.execute(sql`
    SELECT
      id::text AS id,
      document_id::text AS document_id,
      title,
      path,
      ts_headline(
        'english',
        content,
        plainto_tsquery('english', ${p.query}),
        'MaxWords=25, MinWords=5'
      ) AS snippet,
      ts_rank_cd(tsv, plainto_tsquery('english', ${p.query})) AS rank
    FROM connector_document_chunks
    WHERE tenant_id = ${p.tenant_id}
      AND connector_id = ${p.connector_id}
      AND tsv @@ plainto_tsquery('english', ${p.query})
    ORDER BY rank DESC
    LIMIT ${limit}
  `);
  type Row = {
    id: string;
    document_id: string;
    title: string | null;
    path: string | null;
    snippet: string;
    rank: number | string;
  };
  const rows = (out as unknown as { rows: Row[] }).rows ?? (out as unknown as Row[]);
  return (rows as Row[]).map((r) => ({
    id: r.id,
    document_id: r.document_id,
    title: r.title,
    path: r.path,
    snippet: r.snippet,
    rank: Number(r.rank),
  }));
}

// Touch byteLen so the linter doesn't flag an unused import — the
// chunker re-exports it but the service used to rely on it directly.
void byteLen;
