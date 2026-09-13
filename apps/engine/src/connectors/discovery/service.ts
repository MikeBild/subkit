// Shared discovery + cache helper.
//
// Two surfaces invoke this:
//   - the `discover_connector_endpoints` conversation tool
//   - the `POST /v1/connectors/discover` HTTP route
//
// Both surfaces want the same behaviour: hit the persistent cache
// (`knowledge_sources` row of source_type `discovery_endpoint_index`),
// fall through to a live discovery on miss / TTL expiry / explicit
// `force_refresh`, persist the fresh result, and emit a
// `knowledge_source.refreshed` audit row with
// `reason: "discovery_cache_refresh"`.
//
// Caching key derivation, schema layout (single-chunk JSON in
// `knowledge_chunks`), and TTL math are intentionally co-located here so
// the two callers cannot drift apart.

import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";

import { recordKnowledgeSourceRefreshed } from "../../audit/recorders/index.ts";
import { assertInsertRow } from "../../db/assert-insert.ts";
import type { Db, Executor } from "../../db/client.ts";
import { knowledgeChunks, knowledgeSources } from "../../db/schema/knowledge_sources.ts";
import { logger } from "../../logging/logger.ts";
import { applyAuthMaterial, resolveConnectorCredential } from "../drivers/http.ts";
import { attachConnectorSelfDescriptionLinks, getConnectorForEnvironment } from "../service.ts";
import type { ConnectorSelfDescriptionLink } from "../types.ts";
import { discoverConnectorEndpoints, type DiscoverConnectorEndpointsInput } from "./index.ts";
import { DiscoveryError, type DiscoveryResult } from "./types.ts";

/** 24h freshness window for a USEFUL cached endpoint index. */
export const KNOWLEDGE_SOURCE_TTL_MS = 24 * 60 * 60 * 1000;

/** Short freshness window for an EMPTY/negative result (no endpoints AND no
 *  text corpus). A negative discovery — e.g. an upstream that wasn't reachable
 *  or hadn't published its docs yet — must not be cached for a full day, or a
 *  connector created against an already-probed host keeps getting the stale
 *  miss and never picks up the now-available docs. Re-probe ~30 min later
 *  instead, without hammering expensive crawls on every request. */
export const NEGATIVE_TTL_MS = 30 * 60 * 1000;

/** A cached discovery is "useful" when it carries either structured endpoints
 *  or a prose corpus; otherwise it's a negative result on the short TTL. Auth
 *  schemes alone do NOT count — the prod stale-cache trap was exactly a thin
 *  auth-only index blocking a later corpus fetch. */
export function isUsefulDiscovery(result: DiscoveryResult): boolean {
  return (result.endpoints?.length ?? 0) > 0 || Boolean(result.text_corpus);
}

/** 30s discovery network budget, shared by both surfaces. */
export const DISCOVERY_TIMEOUT_MS = 30_000;

/** Free-form `knowledge_sources.source_type` discriminator. */
export const DISCOVERY_SOURCE_TYPE = "discovery_endpoint_index" as const;

export interface DiscoveryServiceArgs {
  template_id?: string;
  base_url?: string;
  ingestion_url?: string;
  force_refresh?: boolean;
  /** When set, the discovery flow loads the connector's persisted credential
   *  (with inline OAuth2 refresh) and injects auth headers into the
   *  introspection / spec fetch. Required for upstreams that gate
   *  introspection behind a token (GitHub GraphQL, Linear, Monday). */
  connector_id?: string;
  /** Connector environment used for the credential lookup. Defaults to
   *  "dev" — caller is responsible for passing "prod" when running
   *  discovery for a production connector. Without this, a prod
   *  GraphQL connector would resolve no credential (dev row missing)
   *  and the strategy chain would warn-log "discovery failed" forever. */
  environment?: "dev" | "prod";
}

export interface DiscoveryServiceContext {
  db: Db;
  tenant_id: string;
  actor_id: string | null;
  /** Optional caller-supplied abort signal (e.g. user cancelled the
   *  conversation turn). Combined with the 30s timeout. */
  abortSignal?: AbortSignal;
}

export interface DiscoveryServiceResult {
  /** Cached hit or freshly fetched. */
  source: "cache" | "fresh";
  result: DiscoveryResult;
  /** Stable cache key (e.g. `template:stripe`, `url:<sha-prefix>`) for
   *  diagnostics. */
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

/**
 * Map a discovery result to the connector self-description LINK it implies
 * (links only — never the body). The winning strategy + its source_url tell us
 * which machine-doc the connector publishes. The self-healing pass (which probes
 * ALL candidate sources) fills in the others over time.
 */
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

/** Non-fatal: record the connector's self-description link from a discovery
 *  result. Touches only the lightweight `self_description` metadata. */
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
  // Tiered freshness: a useful index lives 24h; a negative/empty one only
  // ~30 min, so a stale miss can't keep blocking a now-available corpus.
  const ttl = isUsefulDiscovery(parsed) ? KNOWLEDGE_SOURCE_TTL_MS : NEGATIVE_TTL_MS;
  if (!isFresh(row.last_refreshed_at, ttl)) return null;
  return {
    result: parsed,
    fetched_at: row.last_refreshed_at?.toISOString() ?? parsed.fetched_at,
  };
}

/**
 * OPT-E: read the cached discovery/introspection index for a connector's
 * base_url — the slug the discover tool persists under. Lets the authoring
 * context surface a connector's known operations WITHOUT re-introspecting (and
 * without an agent round-trip). Returns null on miss / stale (24h TTL); the
 * agent's on-demand `discover_connector_endpoints` is the fallback. Generic over
 * REST + GraphQL — both store the same `discovery_endpoint_index` shape.
 */
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

/**
 * Resolve a connector's discovery index robustly, independent of which key
 * the discover tool cached under. The base_url-only lookup ({@link
 * readDiscoveryIndexForBaseUrl}) misses whenever discovery ran via an
 * `ingestion_url` (e.g. `…/openapi.json`) or a `template_id` — the row is
 * keyed under that URI, not the bare base_url. This widens the lookup to the
 * URIs a connector can legitimately be discovered under:
 *   1. the bare `base_url`,
 *   2. the common spec path `<base_url>/openapi.json`,
 *   3. every `source_uri` recorded on the connector's `self_description`
 *      links (the OpenAPI / llms.txt URLs discovery itself captured).
 * First useful hit wins. Returns null when none resolve (fail-open — the
 * caller degrades to the on-demand discover tool). Tenant-scoped throughout.
 */
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
  const version = createHash("sha256").update(json).digest("hex").slice(0, 32);
  const bytes = Buffer.byteLength(json, "utf8");
  const now = new Date();

  const existing = await ctx.db
    .select()
    .from(knowledgeSources)
    .where(
      and(eq(knowledgeSources.tenant_id, ctx.tenant_id), eq(knowledgeSources.slug, cache.slug)),
    )
    .limit(1);
  const prior = existing[0];

  if (prior) {
    await ctx.db
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
    await ctx.db.delete(knowledgeChunks).where(eq(knowledgeChunks.knowledge_source_id, prior.id));
    await ctx.db.insert(knowledgeChunks).values({
      tenant_id: ctx.tenant_id,
      knowledge_source_id: prior.id,
      ordinal: 0,
      title: result.title,
      path: cache.source_uri,
      content: json,
      byte_size: bytes,
      fingerprint: version,
    });
    await recordKnowledgeSourceRefreshed({
      tenant_id: ctx.tenant_id,
      actor_id: ctx.actor_id,
      executor: ctx.db,
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

  const [inserted] = await ctx.db
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
  await ctx.db.insert(knowledgeChunks).values({
    tenant_id: ctx.tenant_id,
    knowledge_source_id: inserted.id,
    ordinal: 0,
    title: result.title,
    path: cache.source_uri,
    content: json,
    byte_size: bytes,
    fingerprint: version,
  });
  await recordKnowledgeSourceRefreshed({
    tenant_id: ctx.tenant_id,
    actor_id: ctx.actor_id,
    executor: ctx.db,
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

/**
 * Run the cached discovery pipeline.
 *
 * Cache-hit returns immediately (no audit row — only a refresh writes
 * one). Cache-miss / `force_refresh: true` runs the multi-strategy
 * discovery chain bounded by `DISCOVERY_TIMEOUT_MS`, persists the
 * result, and emits the audit row.
 *
 * On `all_strategies_failed` the underlying `DiscoveryError` propagates
 * — callers map it to the surface-appropriate error envelope (HTTP 503
 * for the route, structured tool error for the conversation tool).
 */
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
    // Resolve auth headers from the connector's persisted credential when
    // a connector_id was supplied. Without this, introspecting GitHub /
    // Linear / Monday GraphQL schemas required the operator to manually
    // pass headers — most APIs gate introspection behind a token.
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
        // Failure to resolve auth is a soft-fail: we attempt unauth'd
        // discovery and let the strategy return a typed error if the
        // upstream rejects. Pre-fix this path didn't exist at all.
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
