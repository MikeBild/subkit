import { z } from "@hono/zod-openapi";
import { type EndpointScore, scoreEndpoints } from "../../connectors/discovery/endpoint-scorer.ts";
import { recognizeAuthFromSchemes } from "../../connectors/discovery/recognize-auth.ts";
import {
  KNOWLEDGE_SOURCE_TTL_MS as DISCOVERY_TTL_MS,
  runDiscoveryCached,
} from "../../connectors/discovery/service.ts";
import { DiscoveryError, type DiscoveryResult } from "../../connectors/discovery/types.ts";
import { getConnector } from "../../connectors/service.ts";
import { logger } from "../../logging/logger.ts";
import type { ConversationTool, ToolResult } from "./index.ts";

export const KNOWLEDGE_SOURCE_TTL_MS = DISCOVERY_TTL_MS;

const inputSchema = z
  .object({
    connector_id: z.string().uuid().optional(),
    template_id: z.string().min(1).optional(),
    base_url: z.string().url().optional(),
    ingestion_url: z.string().url().optional(),
    force_refresh: z.boolean().default(false),
  })
  .refine((d) => d.connector_id || d.template_id || d.base_url || d.ingestion_url, {
    message: "one of connector_id, template_id, base_url, or ingestion_url is required",
  })
  .openapi("DiscoverConnectorEndpointsToolInput");

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
    "Discovers what an API can do BEFORE you author against it. For REST it fetches the OpenAPI/Swagger spec; for a GraphQL connector it runs `__schema` introspection (pass the GraphQL endpoint as `base_url`) and returns every query/mutation root field flattened with its args, enum values, and input-field shapes — AND ingests the full schema (SDL) as searchable knowledge you can then `search_knowledge`. Either way you get a curated list of endpoints with auth schemes, parameters, and pagination hints. Call this **before** probing or proposing workflow steps so field names, enum values (casing matters), and filter/connection shapes come from the real schema instead of guesses — essential for GraphQL, where list fields are usually Relay connections (`edges{node}`) and orderBy/enum values are schema-defined. To introspect a connector you already have in scope, pass its `connector_id` — the tool uses that connector's stored base_url (no need to re-type the URL or guess a template slug). Cached per-tenant for 24h; pass `force_refresh: true` to re-fetch.",
  inputSchema,
  category: "tenant_read",
  authoring_only: true,
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
      let resolvedBaseUrl = args.base_url;
      if (args.connector_id && !resolvedBaseUrl) {
        const connector = await getConnector(ctx.tenant_id, args.connector_id, ctx.db);
        if (!connector) {
          return {
            ok: false,
            error_code: "connector_not_found",
            message: `no connector with id '${args.connector_id}' in this tenant`,
            next_best_actions: ["list_connectors", "get_connector"],
            data: { connector_id: args.connector_id },
          };
        }
        if (!connector.base_url) {
          return {
            ok: false,
            error_code: "connector_has_no_base_url",
            message: `connector '${connector.slug}' has no base_url to introspect; pass base_url or ingestion_url explicitly`,
            next_best_actions: ["get_connector"],
            data: { connector_id: args.connector_id },
          };
        }
        resolvedBaseUrl = connector.base_url;
      }
      const actor_type = ctx.principal?.kind ?? ctx.engineClient.context.actor_type;
      const out = await runDiscoveryCached(
        {
          db: ctx.db,
          tenant_id: ctx.tenant_id,
          ...(actor_type ? { actor_type } : {}),
          actor_id: ctx.actor_id,
          ...(ctx.abortSignal ? { abortSignal: ctx.abortSignal } : {}),
        },
        {
          ...(args.template_id ? { template_id: args.template_id } : {}),
          ...(resolvedBaseUrl ? { base_url: resolvedBaseUrl } : {}),
          ...(args.ingestion_url ? { ingestion_url: args.ingestion_url } : {}),
          ...(args.connector_id ? { connector_id: args.connector_id } : {}),
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
