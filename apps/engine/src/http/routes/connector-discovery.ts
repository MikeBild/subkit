// `POST /v1/connectors/discover` — programmatic surface for connector
// endpoint discovery.
//
// Mirrors the conversation tool `discover_connector_endpoints` so CI
// scripts and headless callers can reach discovery without a conversation.
// Both call into `runDiscoveryCached` from `connectors/discovery/service.ts`
// — the cache + audit semantics (24h TTL in `knowledge_sources`,
// `knowledge_source.refreshed` audit row with reason
// `"discovery_cache_refresh"`) are identical across surfaces.
//
// RBAC: `connector:read` on the tenant scope. The route doesn't read or
// mutate a specific connector — it operates on a template id or URL —
// so the resource descriptor is omitted (tenant-scoped grant only).
//
// Errors:
//   400 — neither template_id nor base_url nor ingestion_url provided
//         (Zod refinement); also bubbles `template_not_found`,
//         `template_no_url`, `no_url_provided` from the discovery module.
//   403 — RBAC (handled by middleware).
//   503 — discovery ran but every strategy bailed (`all_strategies_failed`).
//         A 502 might also fit, but 503 is closer to "the upstream is
//         currently unreachable" which is what every-strategy-fails
//         actually means.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { ErrorSchema } from "../../api/common-schemas.ts";
import { DiscoveryResultSchema } from "../../api/connector-schemas.ts";
import { DiscoveryError, runDiscoveryCached } from "../../connectors/index.ts";
import { logger } from "../../logging/index.ts";
import { BadRequestError, HttpError } from "../errors.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const DiscoverRequestSchema = z
  .object({
    template_id: z.string().min(1).optional(),
    base_url: z.string().url().optional(),
    ingestion_url: z.string().url().optional(),
    force_refresh: z.boolean().optional(),
  })
  .refine((d) => Boolean(d.template_id || d.base_url || d.ingestion_url), {
    message: "one of template_id, base_url, or ingestion_url is required",
  })
  .openapi("ConnectorDiscoverRequest");

const DiscoverResponseSchema = z
  .object({
    source: z.enum(["cache", "fresh"]),
    cache_key: z.string(),
    result: DiscoveryResultSchema,
  })
  .openapi("ConnectorDiscoverResponse");

const discoverRoute = createRoute({
  method: "post",
  path: "/v1/connectors/discover",
  tags: ["connectors"],
  summary: "Discover endpoints for a connector template or URL",
  description:
    "Runs the multi-strategy discovery pipeline (OpenAPI direct → GraphQL introspection → Swagger UI scrape → llms.txt → HTML scrape → Playwright crawl) for the given template_id, ingestion_url, or base_url. Cached per-tenant for 24h in knowledge_sources; pass force_refresh:true to bypass.",
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { "application/json": { schema: DiscoverRequestSchema } } },
  },
  responses: {
    200: {
      description: "OK",
      content: { "application/json": { schema: DiscoverResponseSchema } },
    },
    400: { description: "Bad request", content: { "application/json": { schema: ErrorSchema } } },
    403: { description: "Forbidden", content: { "application/json": { schema: ErrorSchema } } },
    503: {
      description: "Discovery failed (all strategies bailed)",
      content: { "application/json": { schema: ErrorSchema } },
    },
  },
});

class DiscoveryUnavailableError extends HttpError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(503, "discovery_unavailable", message, details ? { details } : {});
  }
}

export function registerConnectorDiscoveryRoutes(app: OpenAPIHono<AppEnv>): void {
  // RBAC. Tenant-scoped read permission — discovery doesn't mutate any
  // specific connector, only the per-tenant knowledge_sources cache.
  app.use("/v1/connectors/discover", requirePermission("connector:read"));

  app.openapi(discoverRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const body = c.req.valid("json");

    try {
      const out = await runDiscoveryCached(
        {
          db,
          tenant_id: principal.tenant_id,
          actor_id: principal.id,
        },
        {
          ...(body.template_id ? { template_id: body.template_id } : {}),
          ...(body.base_url ? { base_url: body.base_url } : {}),
          ...(body.ingestion_url ? { ingestion_url: body.ingestion_url } : {}),
          ...(body.force_refresh !== undefined ? { force_refresh: body.force_refresh } : {}),
        },
      );
      return c.json(
        {
          source: out.source,
          cache_key: out.cache_key,
          result: out.result,
        },
        200,
      );
    } catch (err) {
      if (err instanceof DiscoveryError) {
        logger.warn({
          module: "http",
          action: "connector_discover.failed",
          tenant_id: principal.tenant_id,
          error_code: err.code,
          error_message: err.message,
        });
        // Map machine-readable discovery codes to surface-appropriate
        // HTTP statuses. Every strategy failing is a 503; bad input
        // shape is 400. Anything else is treated as 503.
        if (
          err.code === "no_url_provided" ||
          err.code === "template_not_found" ||
          err.code === "template_no_url"
        ) {
          throw new BadRequestError(err.message, { discovery_code: err.code });
        }
        throw new DiscoveryUnavailableError(err.message, { discovery_code: err.code });
      }
      throw err;
    }
  });
}
