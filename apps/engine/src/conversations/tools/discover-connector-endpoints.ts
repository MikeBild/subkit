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
//
// The persistence + cache plumbing lives in
// `connectors/discovery/service.ts` so the matching HTTP route
// (`POST /v1/connectors/discover`) shares the same path. This module
// owns only the conversation-specific concerns: the recent-user-message
// scoring and the structured `next_best_actions` envelope on empty
// results.

import { z } from "@hono/zod-openapi";
import { type EndpointScore, scoreEndpoints } from "../../connectors/discovery/endpoint-scorer.ts";
import { recognizeAuthFromSchemes } from "../../connectors/discovery/recognize-auth.ts";
import {
  KNOWLEDGE_SOURCE_TTL_MS as DISCOVERY_TTL_MS,
  runDiscoveryCached,
} from "../../connectors/discovery/service.ts";
import { DiscoveryError, type DiscoveryResult } from "../../connectors/discovery/types.ts";
import { logger } from "../../logging/logger.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

/** 24h freshness window for cached endpoint indexes. Re-exported here
 *  for tests + tooling that referenced it under this module path. */
export const KNOWLEDGE_SOURCE_TTL_MS = DISCOVERY_TTL_MS;

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

/** Build a `suggested_endpoints` payload from the operator's message,
 *  if any. Returns `null` when the message is missing/empty/stop-words —
 *  callers omit the field entirely so the LLM doesn't see noise. */
function maybeSuggestEndpoints(
  message: string | null | undefined,
  result: DiscoveryResult,
): EndpointScore[] | null {
  if (!message) return null;
  const ranked = scoreEndpoints(message, result.endpoints, 3);
  return ranked.length > 0 ? ranked : null;
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
    try {
      const out = await runDiscoveryCached(
        {
          db: ctx.db,
          tenant_id: ctx.tenant_id,
          actor_id: ctx.actor_id,
          ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
        },
        {
          ...(args.template_id ? { template_id: args.template_id } : {}),
          ...(args.base_url ? { base_url: args.base_url } : {}),
          ...(args.ingestion_url ? { ingestion_url: args.ingestion_url } : {}),
          force_refresh: args.force_refresh,
        },
      );
      const suggested = maybeSuggestEndpoints(ctx.recentUserMessage, out.result);
      return finalizeOk({
        source: out.source,
        result: out.result,
        suggested,
      });
    } catch (err) {
      const code = err instanceof DiscoveryError ? err.code : "discovery_failed";
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({
        module: "conversation_tool",
        action: "discover_connector_endpoints.error",
        tenant_id: ctx.tenant_id,
        conversation_id: ctx.conversation_id,
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
    }
  },
};

/**
 * Compose the success-shape envelope. When the discovery chain returned
 * neither structured endpoints nor a `text_corpus` (i.e. the spec was
 * not found via any strategy), we surface `next_best_actions:
 * ["discover_systems_from_files"]` so the agent reaches for the
 * file-based fallback (uploaded README, architecture doc) instead of
 * abandoning the turn.
 *
 * Informational `recommended_auth_type` is derived deterministically from
 * the spec's securitySchemes. This tool is tenant_read — it does NOT
 * mutate any draft. Callers (e.g. start_connector_from_description) own
 * the decision of whether to act on this hint.
 */
function finalizeOk(p: {
  source: "fresh" | "cache";
  result: DiscoveryResult;
  suggested: EndpointScore[] | null;
}): ToolResult {
  const data: Record<string, unknown> = { source: p.source, result: p.result };
  if (p.suggested) data.suggested_endpoints = p.suggested;
  const noStructure = p.result.endpoints.length === 0 && !p.result.text_corpus;
  if (noStructure) {
    data.next_best_actions = ["discover_systems_from_files"];
  }
  // Surface a deterministic auth hint so the authoring loop can steer
  // the operator toward the right credential type without guessing.
  const recognized = recognizeAuthFromSchemes(p.result.auth_schemes);
  if (recognized) {
    data.recommended_auth_type = recognized.auth_type;
    if (recognized.auth_type === "oauth2" && recognized.oauth) {
      data.oauth_metadata = {
        scheme_name: recognized.scheme_name,
        grant_type: recognized.oauth.grant_type,
        ...(recognized.oauth.authorization_endpoint
          ? { authorization_endpoint: recognized.oauth.authorization_endpoint }
          : {}),
        ...(recognized.oauth.token_endpoint
          ? { token_endpoint: recognized.oauth.token_endpoint }
          : {}),
        ...(recognized.oauth.scope ? { scope: recognized.oauth.scope } : {}),
      };
    }
  }
  return { ok: true, data };
}
