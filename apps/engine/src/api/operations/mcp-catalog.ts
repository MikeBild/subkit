import { z } from "@hono/zod-openapi";
import { getConfig } from "../../config/loader.ts";
import { assembleCatalog } from "../../mcp/capabilities/catalog-budget.ts";
import { listWorkflowTools } from "../../mcp/capabilities/tools-helpers.ts";
import { resolveMcpMode } from "../../mcp/mode-resolver.ts";
import { listActivePromptSkills, listResourceConnectors } from "../../tools/mcp-catalog-sources.ts";
import { paginatedResponse } from "../common-schemas.ts";
import { defineOperation, reject } from "./index.ts";

const TAGS = ["mcp"] as const;

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

type PromptRows = Awaited<ReturnType<typeof listActivePromptSkills>>;
type ResourceRows = Awaited<ReturnType<typeof listResourceConnectors>>;

interface McpToolEntry {
  readonly name: string;
  readonly description: string;
  readonly input_shape: unknown;
}

export const listMcpPromptsOperation = defineOperation<null, PromptRows>({
  id: "mcp.prompt.list",
  summary: "List MCP prompts (skills) visible to the caller",
  permission: "mcp:read",
  effect: "read",
  handler: (scope) => listActivePromptSkills(scope.db, scope.tenant_id),
  http: {
    method: "get",
    path: "/v1/mcp/prompts",
    tags: TAGS,
    response: McpPromptsResponse,
    toInput: () => null,
    toBody: (rows) => ({
      items: rows.map((r) => ({
        name: `skill_${r.id}`,
        description: r.title,
        scope: r.scope,
        skill_id: r.id,
      })),
    }),
  },
});

export const listMcpResourcesOperation = defineOperation<null, ResourceRows>({
  id: "mcp.resource.list",
  summary: "List MCP resources (connectors) visible to the caller",
  permission: "mcp:read",
  effect: "read",
  handler: (scope) => listResourceConnectors(scope.db, scope.tenant_id),
  http: {
    method: "get",
    path: "/v1/mcp/resources",
    tags: TAGS,
    response: McpResourcesResponse,
    toInput: () => null,
    toBody: (rows) => ({
      items: rows.map((r) => ({
        uri: `connector://${r.id}`,
        name: r.slug,
        description: `${r.display_name} (${r.driver})`,
        mime_type: "application/json",
      })),
    }),
  },
});

export const listMcpToolsOperation = defineOperation<null, McpToolEntry[]>({
  id: "mcp.tool.list",
  summary: "List the MCP tool catalog this principal would receive over tools/list",
  permission: "mcp:read",
  effect: "read",
  async handler(scope) {
    const principal = scope.principal;
    if (!principal) return reject.unauthorized();
    const mode = resolveMcpMode(principal);
    const readOnly = getConfig(principal.tenant_id).mcp.read_only;
    const fullPalette = await listWorkflowTools({ db: scope.db, principal });
    return assembleCatalog({ principal, mode, readOnly, fullPalette }).map((t) => ({
      name: t.name,
      description: t.description ?? "",
      input_shape: t.inputSchema ?? null,
    }));
  },
  http: {
    method: "get",
    path: "/v1/mcp/tools",
    tags: TAGS,
    response: McpToolsResponse,
    toInput: () => null,
    toBody: (items) => ({ items }),
  },
});
