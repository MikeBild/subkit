import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { recordKnowledgeSourceRefreshed } from "../../audit/recorders/index.ts";
import { assertInsertRow } from "../../db/assert-insert.ts";
import type { Db, Executor } from "../../db/client.ts";
import { knowledgeChunks, knowledgeSources } from "../../db/schema/knowledge_sources.ts";
import { knowledgeContentHash, recordKnowledgeVersion } from "../../knowledge/version-record.ts";
import { logger } from "../../logging/logger.ts";
import { applyAuthMaterial, resolveConnectorCredential } from "../drivers/http.ts";
import { attachConnectorSelfDescriptionLinks, getConnectorForEnvironment } from "../service.ts";
import type { ConnectorSelfDescriptionLink } from "../types.ts";
import { type DiscoverConnectorEndpointsInput, discoverConnectorEndpoints } from "./index.ts";
import { DiscoveryError, type DiscoveryResult } from "./types.ts";

export const KNOWLEDGE_SOURCE_TTL_MS = 24 * 60 * 60 * 1000;

export const NEGATIVE_TTL_MS = 30 * 60 * 1000;

export function isUsefulDiscovery(result: DiscoveryResult): boolean {
  return (result.endpoints?.length ?? 0) > 0 || Boolean(result.text_corpus);
}

export const DISCOVERY_TIMEOUT_MS = 30_000;

export const DISCOVERY_SOURCE_TYPE = "discovery_endpoint_index" as const;

export interface DiscoveryServiceArgs {
  template_id?: string;
  base_url?: string;
  ingestion_url?: string;
  force_refresh?: boolean;
  connector_id?: string;
  environment?: "dev" | "prod";
}

export interface DiscoveryServiceContext {
  db: Db;
  tenant_id: string;
  actor_id: string | null;
  abortSignal?: AbortSignal;
}

export interface DiscoveryServiceResult {
  source: "cache" | "fresh";
  result: DiscoveryResult;
  cache_key: string;
}

interface CacheKey {
  readonly key: string;
  readonly slug: string;
  readonly source_uri: string;
}

function slugSafe(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function deriveCacheKey(args: DiscoveryServiceArgs): CacheKey {
  if (args.template_id) {
    const slug = `discovery-template-${slugSafe(args.template_id)}`.slice(0, 100);
    return {
      key: `template:${args.template_id}`,
      slug,
      source_uri: `template:${args.template_id}`,
    };
  }
  const url = args.ingestion_url ?? args.base_url;
  if (!url) {
    throw new DiscoveryError(
      "no_url_provided",
      "discoverConnectorEndpoints requires template_id, ingestion_url, or base_url",
    );
  }
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const slug = `discovery-url-${hash}`.slice(0, 100);
  return { key: `url:${url}`, slug, source_uri: url };
}

export function selfDescriptionLinksFromResult(
  result: DiscoveryResult,
): ConnectorSelfDescriptionLink[] {
  const url = result.source_url;
  if (!url) return [];
  const discovered_at = result.fetched_at || new Date().toISOString();
  const mk = (kind: ConnectorSelfDescriptionLink["kind"]): ConnectorSelfDescriptionLink[] => [
    { kind, url, source: "discovery", discovered_at },
  ];
  switch (result.strategy) {
    case "llms-txt":
      return mk(url.endsWith("llms-full.txt") ? "llms_full" : "llms_txt");
    case "openapi-direct":
    case "swagger-ui-scrape":
      return mk("openapi");
    case "graphql-introspect":
      return mk("graphql");
    default:
      return [];
  }
}

async function captureConnectorSelfDescription(
  ctx: DiscoveryServiceContext,
  connector_id: string,
  result: DiscoveryResult,
): Promise<void> {
  const links = selfDescriptionLinksFromResult(result);
  if (links.length === 0) return;
  try {
    await attachConnectorSelfDescriptionLinks(
      { tenant_id: ctx.tenant_id, connector_id, links },
      ctx.db,
    );
  } catch (err) {
    logger.warn({
      module: "connector_service",
      action: "discover_connector_endpoints.self_description_capture_failed",
      tenant_id: ctx.tenant_id,
      connector_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function isFresh(last_refreshed_at: Date | null, ttl_ms: number): boolean {
  if (!last_refreshed_at) return false;
  const age = Date.now() - last_refreshed_at.getTime();
  return age >= 0 && age < ttl_ms;
}

interface CachedResult {
  result: DiscoveryResult;
  fetched_at: string;
}

async function readCache(
  db: Db | Executor,
  tenant_id: string,
  slug: string,
): Promise<CachedResult | null> {
  const rows = await db
    .select()
    .from(knowledgeSources)
    .where(and(eq(knowledgeSources.tenant_id, tenant_id), eq(knowledgeSources.slug, slug)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.source_type !== DISCOVERY_SOURCE_TYPE) return null;
  const chunkRows = await db
    .select()
    .from(knowledgeChunks)
    .where(
      and(
        eq(knowledgeChunks.tenant_id, tenant_id),
        eq(knowledgeChunks.knowledge_source_id, row.id),
      ),
    )
    .limit(1);
  const chunk = chunkRows[0];
  if (!chunk) return null;
  let parsed: DiscoveryResult;
  try {
    parsed = JSON.parse(chunk.content) as DiscoveryResult;
  } catch {
    return null;
  }
  const ttl = isUsefulDiscovery(parsed) ? KNOWLEDGE_SOURCE_TTL_MS : NEGATIVE_TTL_MS;
  if (!isFresh(row.last_refreshed_at, ttl)) return null;
  return {
    result: parsed,
    fetched_at: row.last_refreshed_at?.toISOString() ?? parsed.fetched_at,
  };
}

export async function readDiscoveryIndexForBaseUrl(
  db: Executor,
  tenant_id: string,
  base_url: string,
): Promise<DiscoveryResult | null> {
  let slug: string;
  try {
    slug = deriveCacheKey({ base_url }).slug;
  } catch {
    return null;
  }
  const cached = await readCache(db, tenant_id, slug);
  return cached?.result ?? null;
}

export async function readDiscoveryIndexForConnector(
  db: Executor,
  tenant_id: string,
  connector: {
    base_url?: string | null;
    self_description?: { links?: { url?: string }[] } | null;
  },
): Promise<DiscoveryResult | null> {
  const candidates: string[] = [];
  const push = (u: string | null | undefined): void => {
    if (u && !candidates.includes(u)) candidates.push(u);
  };
  if (connector.base_url) {
    push(connector.base_url);
    push(`${connector.base_url.replace(/\/+$/, "")}/openapi.json`);
  }
  for (const link of connector.self_description?.links ?? []) push(link.url);
  for (const uri of candidates) {
    let slug: string;
    try {
      slug = deriveCacheKey({ base_url: uri }).slug;
    } catch {
      continue;
    }
    const cached = await readCache(db, tenant_id, slug);
    if (cached && isUsefulDiscovery(cached.result)) return cached.result;
  }
  return null;
}

async function writeCache(
  ctx: DiscoveryServiceContext,
  cache: CacheKey,
  result: DiscoveryResult,
): Promise<void> {
  const json = JSON.stringify(result);
  const version = knowledgeContentHash(json);
  const bytes = Buffer.byteLength(json, "utf8");
  const now = new Date();
  await ctx.db.transaction((tx) =>
    writeCacheRows(tx, ctx, cache, result, { json, version, bytes, now }),
  );
}

async function writeCacheRows(
  tx: Executor,
  ctx: DiscoveryServiceContext,
  cache: CacheKey,
  result: DiscoveryResult,
  doc: { json: string; version: string; bytes: number; now: Date },
): Promise<void> {
  const { json, version, bytes, now } = doc;
  const content = {
    kind: "document" as const,
    filename: cache.source_uri,
    mime: "application/json",
    text: json,
  };

  const existing = await tx
    .select()
    .from(knowledgeSources)
    .where(
      and(eq(knowledgeSources.tenant_id, ctx.tenant_id), eq(knowledgeSources.slug, cache.slug)),
    )
    .limit(1);
  const prior = existing[0];

  if (prior) {
    await tx
      .update(knowledgeSources)
      .set({
        source_type: DISCOVERY_SOURCE_TYPE,
        source_uri: cache.source_uri,
        version,
        bytes_total: bytes,
        chunk_count: 1,
        last_refreshed_at: now,
        status: "active",
        updated_at: now,
      })
      .where(eq(knowledgeSources.id, prior.id));
    await tx
      .delete(knowledgeChunks)
      .where(
        and(
          eq(knowledgeChunks.tenant_id, ctx.tenant_id),
          eq(knowledgeChunks.knowledge_source_id, prior.id),
        ),
      );
    await tx.insert(knowledgeChunks).values({
      tenant_id: ctx.tenant_id,
      knowledge_source_id: prior.id,
      ordinal: 0,
      title: result.title,
      path: cache.source_uri,
      content: json,
      byte_size: bytes,
      fingerprint: version,
    });
    await recordKnowledgeVersion(tx, {
      tenant_id: ctx.tenant_id,
      knowledge_source_id: prior.id,
      content,
      content_hash: version,
      actor: null,
      note: null,
    });
    await recordKnowledgeSourceRefreshed({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.actor_id,
      executor: tx,
      knowledge_source_id: prior.id,
      source_type: DISCOVERY_SOURCE_TYPE,
      source_uri: cache.source_uri,
      cache_key: cache.key,
      endpoint_count: result.endpoints.length,
      strategy: result.strategy,
      reason: "discovery_cache_refresh",
      created: false,
    });
    return;
  }

  const [inserted] = await tx
    .insert(knowledgeSources)
    .values({
      tenant_id: ctx.tenant_id,
      name: result.title ?? cache.source_uri,
      slug: cache.slug,
      description: `Endpoint index discovered from ${cache.source_uri}`,
      scope: "global",
      workflow_id: null,
      status: "active",
      source_type: DISCOVERY_SOURCE_TYPE,
      source_uri: cache.source_uri,
      mime_type: "application/json",
      version,
      bytes_total: bytes,
      chunk_count: 1,
      refresh_strategy: "manual",
      last_refreshed_at: now,
    })
    .returning();
  assertInsertRow(inserted, "knowledge_sources");
  await tx.insert(knowledgeChunks).values({
    tenant_id: ctx.tenant_id,
    knowledge_source_id: inserted.id,
    ordinal: 0,
    title: result.title,
    path: cache.source_uri,
    content: json,
    byte_size: bytes,
    fingerprint: version,
  });
  await recordKnowledgeVersion(tx, {
    tenant_id: ctx.tenant_id,
    knowledge_source_id: inserted.id,
    content,
    content_hash: version,
    actor: null,
    note: null,
  });
  await recordKnowledgeSourceRefreshed({
    tenant_id: ctx.tenant_id,
    actor_id: ctx.actor_id,
    executor: tx,
    knowledge_source_id: inserted.id,
    source_type: DISCOVERY_SOURCE_TYPE,
    source_uri: cache.source_uri,
    cache_key: cache.key,
    endpoint_count: result.endpoints.length,
    strategy: result.strategy,
    reason: "discovery_cache_refresh",
    created: true,
  });
}

export async function runDiscoveryCached(
  ctx: DiscoveryServiceContext,
  args: DiscoveryServiceArgs,
): Promise<DiscoveryServiceResult> {
  const cache = deriveCacheKey(args);

  logger.info({
    module: "connector_service",
    action: "discover_connector_endpoints.started",
    tenant_id: ctx.tenant_id,
    cache_key: cache.key,
    force_refresh: args.force_refresh ?? false,
  });

  if (!args.force_refresh) {
    const cached = await readCache(ctx.db, ctx.tenant_id, cache.slug);
    if (cached) {
      logger.info({
        module: "connector_service",
        action: "discover_connector_endpoints.cached",
        tenant_id: ctx.tenant_id,
        cache_key: cache.key,
        fetched_at: cached.fetched_at,
      });
      if (args.connector_id) {
        await captureConnectorSelfDescription(ctx, args.connector_id, cached.result);
      }
      return { source: "cache", result: cached.result, cache_key: cache.key };
    }
  }

  const controller = new AbortController();
  const userSignal = ctx.abortSignal;
  if (userSignal) {
    if (userSignal.aborted) controller.abort(userSignal.reason);
    else
      userSignal.addEventListener("abort", () => controller.abort(userSignal.reason), {
        once: true,
      });
  }
  const timeout = setTimeout(
    () => controller.abort(new Error("discovery_timeout")),
    DISCOVERY_TIMEOUT_MS,
  );

  try {
    let authHeaders: Record<string, string> | null = null;
    if (args.connector_id) {
      try {
        const connector = await getConnectorForEnvironment(
          ctx.tenant_id,
          args.connector_id,
          args.environment ?? "dev",
          ctx.db,
        );
        if (connector) {
          const { credential } = await resolveConnectorCredential({
            db: ctx.db,
            tenant_id: ctx.tenant_id,
            connector,
          });
          if (credential) {
            const headers: Record<string, string> = {};
            const query: Record<string, string | number | boolean> = {};
            applyAuthMaterial(connector, credential, headers, query);
            authHeaders = headers;
          }
        }
      } catch (err) {
        logger.warn({
          module: "connector_service",
          action: "discover_connector_endpoints.auth_resolve_failed",
          tenant_id: ctx.tenant_id,
          connector_id: args.connector_id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const input: DiscoverConnectorEndpointsInput = {
      signal: controller.signal,
      ...(args.template_id ? { template_id: args.template_id } : {}),
      ...(args.ingestion_url ? { ingestion_url: args.ingestion_url } : {}),
      ...(args.base_url ? { base_url: args.base_url } : {}),
      ...(authHeaders ? { headers: authHeaders } : {}),
    };
    const result = await discoverConnectorEndpoints(input);
    await writeCache(ctx, cache, result);
    logger.info({
      module: "connector_service",
      action: "discover_connector_endpoints.fresh",
      tenant_id: ctx.tenant_id,
      cache_key: cache.key,
      endpoint_count: result.endpoints.length,
      strategy: result.strategy,
    });
    if (args.connector_id) {
      await captureConnectorSelfDescription(ctx, args.connector_id, result);
    }
    return { source: "fresh", result, cache_key: cache.key };
  } finally {
    clearTimeout(timeout);
  }
}
