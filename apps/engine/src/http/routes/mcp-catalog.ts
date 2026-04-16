// REST read-only views over the MCP capability catalog.
//
// These endpoints exist so the `sk` CLI slash picker can list MCP
// prompts and resources without speaking the MCP stdio/streamable
// protocol itself. Everything returned here mirrors what the engine
// exposes over MCP: prompts come from the skills table, resources
// come from the connectors table, tools come from the conversation
// tool palette. The endpoints are gated on `mcp:read` and never
// include credentials or other secret-bearing fields.

import { createRoute, type OpenAPIHono, z } from "@hono/zod-openapi";
import { and, desc, eq } from "drizzle-orm";
import { connectors, skills } from "../../db/schema/index.ts";
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

const McpPromptsResponse = z
  .object({ items: z.array(McpPromptSchema) })
  .openapi("McpPromptsResponse");

const McpResourcesResponse = z
  .object({ items: z.array(McpResourceSchema) })
  .openapi("McpResourcesResponse");

const McpToolsResponse = z.object({ items: z.array(McpToolSchema) }).openapi("McpToolsResponse");

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
  summary: "List conversation tool-call palette entries",
  security: [{ bearerAuth: [] }],
  responses: {
    200: { description: "OK", content: { "application/json": { schema: McpToolsResponse } } },
  },
});

// Static conversation-tool catalog. Mirrors the structured-intent
// palette exposed to the converse flow. Kept inline so the HTTP
// surface does not pull in the loop module.
const CONVERSATION_TOOLS = [
  {
    name: "propose_step",
    description: "Propose a new step for the current workflow draft",
  },
  {
    name: "update_param",
    description: "Update a parameter on an existing step",
  },
  {
    name: "connect_steps",
    description: "Wire two steps together with an explicit data path",
  },
  {
    name: "dry_run_step",
    description: "Execute a step against a sandbox to validate shape",
  },
  {
    name: "validate_draft",
    description: "Run the full draft validator and surface errors",
  },
  {
    name: "request_human_approval",
    description: "Pause the loop and ask the operator for approval",
  },
  {
    name: "commit_draft",
    description: "Persist the draft as a new workflow version",
  },
] as const;

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
          name: `skill.${r.id}`,
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
      .where(eq(connectors.tenant_id, principal.tenant_id))
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
    return c.json(
      {
        items: CONVERSATION_TOOLS.map((t) => ({
          name: t.name,
          description: t.description,
          input_shape: null,
        })),
      },
      200,
    );
  });
}
