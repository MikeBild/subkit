// discover_connector_endpoints — wraps the multi-strategy ingestion module
// (apps/engine/src/connectors/discovery/) so the LLM can ground its
// endpoint choices in a real OpenAPI/Swagger spec instead of guessing.
//
// Why this exists. Session 00b93a52 had the agent guess `/account` and
// `/projects` against DigitalOcean, hit 404s, and burn ~216k tokens on
// retries. Templates record `ingestion_url` pointing at the spec; the
// discovery module already parses that URL. This tool is the
// conversational surface — call it BEFORE probing or proposing
// workflow steps.
//
// Caching contract. Result is persisted as a `knowledge_sources` row
// with `source_type = "discovery_endpoint_index"`, scoped to the tenant
// via `tenant_id` and uniquely keyed via `slug` (which encodes the
// cache key — template id or URL hash — plus the environment). The
// JSON `DiscoveryResult` lives in a single `knowledge_chunks` row so
// the existing storage path (parsers, dedup, search) stays consistent.
// `last_refreshed_at` is the cache timestamp; `KNOWLEDGE_SOURCE_TTL_MS`
// (24h) is the freshness window.

import { createHash } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { and, eq } from "drizzle-orm";
import { recordKnowledgeSourceRefreshed } from "../../audit/recorders/index.ts";
import {
  type DiscoverConnectorEndpointsInput,
  type DiscoveryResult,
  discoverConnectorEndpoints,
} from "../../connectors/discovery/index.ts";
import { DiscoveryError } from "../../connectors/discovery/types.ts";
import { knowledgeChunks, knowledgeSources } from "../../db/schema/knowledge_sources.ts";
import { logger } from "../../logging/logger.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

/** 24h freshness window for cached endpoint indexes. */
export const KNOWLEDGE_SOURCE_TTL_MS = 24 * 60 * 60 * 1000;

/** 30s discovery network budget — strategies fan out across multiple
 *  fetches, but the wall-clock budget for the conversation tool turn is
 *  bounded so the LLM doesn't stall an interactive session. */
const DISCOVERY_TIMEOUT_MS = 30_000;

/** Free-form `knowledge_sources.source_type` discriminator. The column
 *  is `text` (not an enum) so adding a new value requires no migration —
 *  see schema in `db/schema/knowledge_sources.ts`. */
const SOURCE_TYPE = "discovery_endpoint_index" as const;

const inputSchema = z
  .object({
    template_id: z.string().min(1).optional(),
    base_url: z.string().url().optional(),
    ingestion_url: z.string().url().optional(),
    force_refresh: z.boolean().default(false),
  })
  .refine((d) => d.template_id || d.base_url || d.ingestion_url, {
    message: "one of template_id, base_url, or ingestion_url is required",
  })
  .openapi("DiscoverConnectorEndpointsToolInput");

type DiscoveryToolArgs = z.infer<typeof inputSchema>;

interface CacheKey {
  /** Stable identifier the slug encodes (`template:digitalocean` or
   *  `url:<sha-prefix>`). Surfaced on the result for debugging. */
  readonly key: string;
  /** Persisted slug — unique per `(tenant_id, slug)`. */
  readonly slug: string;
  /** Original source URL recorded for audit + display. */
  readonly source_uri: string;
}

function deriveCacheKey(args: DiscoveryToolArgs): CacheKey {
  // Slug is constrained to 100 chars by knowledge_sources schema and must
  // be lowercase + dash-only. We generate it deterministically so a
  // re-run hits the same row regardless of caller order.
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
    // Should be unreachable thanks to the .refine() guard, but the
    // exhaustiveness keeps TS honest without a non-null assertion.
    throw new Error("deriveCacheKey: no template_id, ingestion_url, or base_url");
  }
  const hash = createHash("sha256").update(url).digest("hex").slice(0, 16);
  const slug = `discovery-url-${hash}`.slice(0, 100);
  return { key: `url:${url}`, slug, source_uri: url };
}

function slugSafe(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function isFresh(last_refreshed_at: Date | null): boolean {
  if (!last_refreshed_at) return false;
  const age = Date.now() - last_refreshed_at.getTime();
  return age >= 0 && age < KNOWLEDGE_SOURCE_TTL_MS;
}

export const discoverConnectorEndpointsTool: ConversationTool = {
  name: "discover_connector_endpoints",
  description:
    "Fetches the OpenAPI/Swagger spec for a connector template (or any URL) and returns a curated list of endpoints with auth schemes, parameters, and pagination hints. Call this **before** probing or proposing workflow steps so endpoint choices are grounded in real spec data instead of guesses. Cached per-tenant for 24h; pass `force_refresh: true` to re-fetch.",
  inputSchema,
  category: "tenant_read",
  use_case:
    "Before drafting a workflow step that hits a third-party API, run this so endpoint paths, auth schemes, and pagination come from the vendor's spec instead of guesses.",
  important_notes: [
    "Cached per-tenant in `knowledge_sources` for 24h. Pass `force_refresh: true` only when the user explicitly says the spec changed.",
    "Network-bounded to 30s. On failure, the tool returns a structured error with `next_best_actions` so the agent can fall back to `fetch_connector_docs` or `ask_user_*`.",
    "Provide exactly one of `template_id`, `ingestion_url`, or `base_url`. If you have a template in scope, prefer `template_id`.",
  ],
  example_input: { template_id: "digitalocean" },
  async execute(ctx, rawArgs): Promise<ToolResult> {
    const args = inputSchema.parse(rawArgs);
    const cache = deriveCacheKey(args);

    logger.info({
      module: "conversation_tool",
      action: "discover_connector_endpoints.started",
      tenant_id: ctx.tenant_id,
      conversation_id: ctx.conversation_id,
      cache_key: cache.key,
      force_refresh: args.force_refresh,
    });

    if (!args.force_refresh) {
      const cached = await readCache(ctx.db, ctx.tenant_id, cache.slug);
      if (cached) {
        logger.info({
          module: "conversation_tool",
          action: "discover_connector_endpoints.cached",
          tenant_id: ctx.tenant_id,
          conversation_id: ctx.conversation_id,
          cache_key: cache.key,
          fetched_at: cached.fetched_at,
        });
        return {
          ok: true,
          data: { source: "cache", result: cached.result },
        };
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
      const input: DiscoverConnectorEndpointsInput = {
        signal: controller.signal,
        ...(args.template_id ? { template_id: args.template_id } : {}),
        ...(args.ingestion_url ? { ingestion_url: args.ingestion_url } : {}),
        ...(args.base_url ? { base_url: args.base_url } : {}),
      };
      const result = await discoverConnectorEndpoints(input);
      await writeCache(ctx, cache, result);
      logger.info({
        module: "conversation_tool",
        action: "discover_connector_endpoints.fresh",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        cache_key: cache.key,
        endpoint_count: result.endpoints.length,
        strategy: result.strategy,
      });
      return { ok: true, data: { source: "fresh", result } };
    } catch (err) {
      const code = err instanceof DiscoveryError ? err.code : "discovery_failed";
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({
        module: "conversation_tool",
        action: "discover_connector_endpoints.error",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
        cache_key: cache.key,
        error_code: code,
        error_message: message,
      });
      return {
        ok: false,
        error_code: code,
        message,
        next_best_actions: ["ask_user", "fetch_connector_docs"],
        data: {
          error_code: code,
          message,
          next_best_actions: ["ask_user", "fetch_connector_docs"],
        },
      };
    } finally {
      clearTimeout(timeout);
    }
  },
};

interface CachedResult {
  result: DiscoveryResult;
  fetched_at: string;
}

/**
 * Read a previously persisted `DiscoveryResult` for the given cache slug,
 * scoped strictly to `tenant_id`. Returns `null` on cache miss, expiry
 * (older than `KNOWLEDGE_SOURCE_TTL_MS`), or any decode failure — the
 * caller treats those identically to a miss and re-fetches.
 */
async function readCache(
  db: Parameters<ConversationTool["execute"]>[0]["db"],
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
  if (row.source_type !== SOURCE_TYPE) return null;
  if (!isFresh(row.last_refreshed_at)) return null;
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
  try {
    const parsed = JSON.parse(chunk.content) as DiscoveryResult;
    return {
      result: parsed,
      fetched_at: row.last_refreshed_at?.toISOString() ?? parsed.fetched_at,
    };
  } catch {
    return null;
  }
}

/**
 * Upsert the discovery result. We always run delete-then-insert so a
 * stale chunk never lingers; the parent row's `last_refreshed_at` is
 * what callers gate freshness on. An audit row records the refresh —
 * the conversation tool itself is read-only, but persistence side-
 * effects must surface to the audit log.
 */
async function writeCache(
  ctx: Parameters<ConversationTool["execute"]>[0],
  cache: CacheKey,
  result: DiscoveryResult,
): Promise<void> {
  const json = JSON.stringify(result);
  const version = createHash("sha256").update(json).digest("hex").slice(0, 32);
  const bytes = Buffer.byteLength(json, "utf8");
  const now = new Date();

  const db = ctx.db;
  const existing = await db
    .select()
    .from(knowledgeSources)
    .where(
      and(eq(knowledgeSources.tenant_id, ctx.tenant_id), eq(knowledgeSources.slug, cache.slug)),
    )
    .limit(1);
  const prior = existing[0];

  if (prior) {
    await db
      .update(knowledgeSources)
      .set({
        source_type: SOURCE_TYPE,
        source_uri: cache.source_uri,
        version,
        bytes_total: bytes,
        chunk_count: 1,
        last_refreshed_at: now,
        status: "active",
        updated_at: now,
      })
      .where(eq(knowledgeSources.id, prior.id));
    await db.delete(knowledgeChunks).where(eq(knowledgeChunks.knowledge_source_id, prior.id));
    await db.insert(knowledgeChunks).values({
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
      knowledge_source_id: prior.id,
      source_type: SOURCE_TYPE,
      source_uri: cache.source_uri,
      cache_key: cache.key,
      endpoint_count: result.endpoints.length,
      strategy: result.strategy,
      reason: "discovery_cache_refresh",
      created: false,
    });
    return;
  }

  const [inserted] = await db
    .insert(knowledgeSources)
    .values({
      tenant_id: ctx.tenant_id,
      name: result.title ?? cache.source_uri,
      slug: cache.slug,
      description: `Endpoint index discovered from ${cache.source_uri}`,
      scope: "global",
      workflow_id: null,
      status: "active",
      source_type: SOURCE_TYPE,
      source_uri: cache.source_uri,
      mime_type: "application/json",
      version,
      bytes_total: bytes,
      chunk_count: 1,
      refresh_strategy: "manual",
      last_refreshed_at: now,
    })
    .returning();
  if (!inserted) throw new Error("knowledge_sources insert returned no row");
  await db.insert(knowledgeChunks).values({
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
    knowledge_source_id: inserted.id,
    source_type: SOURCE_TYPE,
    source_uri: cache.source_uri,
    cache_key: cache.key,
    endpoint_count: result.endpoints.length,
    strategy: result.strategy,
    reason: "discovery_cache_refresh",
    created: true,
  });
}
