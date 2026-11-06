import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { paginatedResponse } from "../../api/common-schemas.ts";
import { getConfig } from "../../config/loader.ts";
import { assembleCatalog, listWorkflowTools, resolveMcpMode } from "../../mcp/index.ts";
import { listActivePromptSkills, listResourceConnectors } from "../../tools/mcp-catalog-sources.ts";
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

async function assembleMcpToolCatalog(
  c: Context<AppEnv>,
): Promise<Array<{ name: string; description: string; input_shape: unknown }>> {
  const principal = requireAuth(c);
  const mode = resolveMcpMode(principal);
  const readOnly = getConfig(principal.tenant_id).mcp.read_only;
  const fullPalette = await listWorkflowTools({ db: c.get("db"), principal });
  return assembleCatalog({ principal, mode, readOnly, fullPalette }).map((t) => ({
    name: t.name,
    description: t.description ?? "",
    input_shape: t.inputSchema ?? null,
  }));
}

export function registerMcpCatalogRoutes(app: OpenAPIHono<AppEnv>): void {
  app.use("/v1/mcp/prompts", requirePermission("mcp:read"));
  app.use("/v1/mcp/resources", requirePermission("mcp:read"));
  app.use("/v1/mcp/tools", requirePermission("mcp:read"));

  app.openapi(promptsRoute, async (c) => {
    const principal = requireAuth(c);
    const rows = await listActivePromptSkills(c.get("db"), principal.tenant_id);
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
    const rows = await listResourceConnectors(c.get("db"), principal.tenant_id);
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
