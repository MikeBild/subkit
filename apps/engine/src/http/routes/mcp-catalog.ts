// REST read-only views over the MCP capability catalog.
//
// These endpoints exist so the `sk` CLI slash picker can list MCP
// prompts and resources without speaking the MCP stdio/streamable
// protocol itself. Everything returned here mirrors what the engine
// exposes over MCP: prompts come from the skills table, resources
// come from the connectors table, and tools come from the same catalog
// `tools/list` serves. The endpoints are gated on `mcp:read` and never
// include credentials or other secret-bearing fields.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Context } from "hono";
import { paginatedResponse } from "../../api/common-schemas.ts";
import { getConfig } from "../../config/loader.ts";
import { connectors, skills } from "../../db/schema/index.ts";
import { assembleCatalog, listWorkflowTools, resolveMcpMode } from "../../mcp/index.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requirePermission } from "../middleware/require-permission.ts";
import type { AppEnv } from "../openapi.ts";

const McpPromptSchema = z
  .object({
    name: z.string(),
    description: z.string().nullable(),
    scope: z.string(),
    skill_id: z.string(),
  })
  .openapi("McpPrompt");

const McpResourceSchema = z
  .object({
    uri: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    mime_type: z.string().nullable(),
  })
  .openapi("McpResource");

const McpToolSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    input_shape: z.unknown(),
  })
  .openapi("McpTool");

const McpPromptsResponse = paginatedResponse(McpPromptSchema, "McpPromptsResponse");
const McpResourcesResponse = paginatedResponse(McpResourceSchema, "McpResourcesResponse");
const McpToolsResponse = paginatedResponse(McpToolSchema, "McpToolsResponse");

const promptsRoute = createRoute({
  method: "get",
  path: "/v1/mcp/prompts",
  tags: ["mcp"],
  summary: "List MCP prompts (skills) visible to the caller",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: McpPromptsResponse } } },
  },
});

const resourcesRoute = createRoute({
  method: "get",
  path: "/v1/mcp/resources",
  tags: ["mcp"],
  summary: "List MCP resources (connectors) visible to the caller",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: McpResourcesResponse } } },
  },
});

const toolsRoute = createRoute({
  method: "get",
  path: "/v1/mcp/tools",
  tags: ["mcp"],
  summary: "List the MCP tool catalog this principal would receive over tools/list",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: McpToolsResponse } } },
  },
});

// The catalog this route reports is assembled by the SAME call the MCP
// `tools/list` handler makes — see `assembleCatalog` in
// mcp/capabilities/catalog-budget.ts.
//
// It used to be a seven-name constant, mapped out unchanged with
// `input_shape: null` and without reading the principal: the same answer for
// every caller in every tenant. Measured against production, that constant and
// the real catalog for the SAME principal shared not one name — 7 versus 107 —
// because those seven were the converse loop's `draft_write` intents, which the
// MCP surface omits on purpose. So the route was not a stale approximation of
// the catalog; it was answering a different question under the catalog's name,
// beside two siblings (`/v1/mcp/prompts`, `/v1/mcp/resources`) that both read
// live data.
//
// Assembling rather than calling `listToolsViaRegistry` directly matters:
// `assembleCatalog` also prepends the conversation cluster and appends the
// capped `wf_` palette. Reporting the registry set alone would be a smaller
// lie in the same shape — a number no client ever receives.
async function assembleMcpToolCatalog(
  c: Context<AppEnv>,
): Promise<Array<{ name: string; description: string; input_shape: unknown }>> {
  // `requireAuth` rather than a bare `c.get`, exactly as the two sibling
  // handlers do: the mode is derived from the principal's scopes, so a missing
  // principal must fail loudly instead of resolving to the product tier.
  const principal = requireAuth(c);
  const mode = resolveMcpMode(principal);
  // `mcp.read_only` is the operator's global off-switch for writes and is read
  // the same way the MCP server reads it, so both surfaces answer alike.
  const readOnly = getConfig(principal.tenant_id).mcp.read_only;
  const fullPalette = await listWorkflowTools({ db: c.get("db"), principal });
  return assembleCatalog({ principal, mode, readOnly, fullPalette }).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    // The declared input schema, not `null`. This is the shape a caller has to
    // satisfy, and it is the only part of the entry that was never populated.
    input_shape: t.inputSchema ?? null,
  }));
}

export function registerMcpCatalogRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/mcp/prompts", requirePermission("mcp:read"));
  app.use("/v1/mcp/resources", requirePermission("mcp:read"));
  app.use("/v1/mcp/tools", requirePermission("mcp:read"));

  app.openapi(promptsRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const rows = await db
      .select({
        id: skills.id,
        title: skills.title,
        scope: skills.scope,
      })
      .from(skills)
      .where(and(eq(skills.tenant_id, principal.tenant_id), eq(skills.lifecycle, "active")))
      .orderBy(desc(skills.created_at));
    return c.json(
      {
        items: rows.map((r) => ({
          name: `skill_${r.id}`,
          description: r.title,
          scope: r.scope,
          skill_id: r.id,
        })),
      },
      200,
    );
  });

  app.openapi(resourcesRoute, async (c) => {
    const principal = requireAuth(c);
    const db = c.get("db");
    const rows = await db
      .select({
        id: connectors.id,
        slug: connectors.slug,
        display_name: connectors.display_name,
        driver: connectors.driver,
      })
      .from(connectors)
      // Live rows only — a soft-deleted connector must not be advertised
      // as an MCP resource (same class as the substitution-resolver bug).
      .where(and(eq(connectors.tenant_id, principal.tenant_id), isNull(connectors.deleted_at)))
      .orderBy(desc(connectors.created_at));
    return c.json(
      {
        items: rows.map((r) => ({
          uri: `connector://${r.id}`,
          name: r.slug,
          description: `${r.display_name} (${r.driver})`,
          mime_type: "application/json",
        })),
      },
      200,
    );
  });

  app.openapi(toolsRoute, async (c) => {
    return c.json({ items: await assembleMcpToolCatalog(c) }, 200);
  });
}
