// MCP exposure of the conversation tool registry.
//
// The generated read + write tools from `conversations/tools/generated/`
// (and hand-written write tools under `.../generated/writes/`) are the
// canonical operator surface. We re-expose them over MCP under the
// `tenant.<tool-name>` prefix so external clients (Claude Code, other
// MCP agents) become first-class subkit operators.
//
// Filters applied:
//   - draft_write tools are NOT exposed (they only make sense inside a
//     subkit conversation draft).
//   - tenant_write tools are gated by the MCP server's `allowWrites`
//     flag (default off). Reads are always available when the caller
//     is authenticated.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { compileDescription } from "../../conversations/tools/describe.ts";
import type {
  ConversationTool,
  ToolCategory,
  ToolContext,
} from "../../conversations/tools/index.ts";
import { listTools } from "../../conversations/tools/index.ts";
import type { Db } from "../../db/client.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { logger } from "../../logging/logger.ts";

export const TENANT_TOOL_PREFIX = "tenant.";

/**
 * Zod → JSON Schema for MCP tool exposure. Uses Zod v4's native
 * `z.toJSONSchema(schema)` which handles `@hono/zod-openapi`-wrapped
 * schemas transparently. Falls back to an empty object shape on any
 * failure so MCP handshake never crashes the server.
 */
function zodToMcpSchema(schema: z.ZodTypeAny): Tool["inputSchema"] {
  try {
    // biome-ignore lint/suspicious/noExplicitAny: z.toJSONSchema typing is unstable across minor versions
    const anyZ = z as any;
    if (typeof anyZ.toJSONSchema === "function") {
      const json = anyZ.toJSONSchema(schema, { target: "jsonSchema7" });
      if (json && typeof json === "object" && (json as { type?: unknown }).type === "object") {
        return json as Tool["inputSchema"];
      }
    }
  } catch (err) {
    logger.debug({
      module: "mcp",
      action: "zod_to_json_failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return { type: "object", properties: {} };
}

function includeTool(category: ToolCategory, allowWrites: boolean): boolean {
  if (category === "draft_write") return false; // draft = in-conversation only
  if (category === "tenant_write") return allowWrites;
  return true; // tenant_read
}

export interface ListTenantToolsOptions {
  allowWrites: boolean;
}

export function listTenantTools(opts: ListTenantToolsOptions): Tool[] {
  const out: Tool[] = [];
  for (const t of listTools()) {
    if (!includeTool(t.category, opts.allowWrites)) continue;
    out.push({
      name: `${TENANT_TOOL_PREFIX}${t.name}`,
      description: compileDescription(t),
      inputSchema: zodToMcpSchema(t.inputSchema),
    });
  }
  return out;
}

export interface HandleTenantToolParams {
  db: Db;
  principal: ResolvedPrincipal;
  name: string;
  args: Record<string, unknown>;
  allowWrites: boolean;
  /**
   * Optional progress notifier. When supplied, the tool's
   * `ctx.onLog(level, message)` emissions are forwarded to MCP
   * `notifications/progress` frames keyed by the caller's
   * `progressToken`. Tools that don't emit progress pass through
   * unchanged.
   */
  onProgress?: (progress: number, message: string) => Promise<void> | void;
}

export interface HandleTenantToolResult {
  isError: boolean;
  content: Array<{ type: "text" } & { text: string }>;
}

export async function handleTenantTool(
  p: HandleTenantToolParams,
): Promise<HandleTenantToolResult | null> {
  if (!p.name.startsWith(TENANT_TOOL_PREFIX)) return null;
  const toolName = p.name.slice(TENANT_TOOL_PREFIX.length);
  const tool: ConversationTool | undefined = listTools().find((t) => t.name === toolName);
  if (!tool) {
    return {
      isError: true,
      content: [{ type: "text", text: `unknown tenant tool: ${toolName}` }],
    };
  }
  if (!includeTool(tool.category, p.allowWrites)) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text:
            tool.category === "draft_write"
              ? "draft_write tools are not exposed over MCP — use conversation.* tools instead"
              : "tenant_write tools disabled on this MCP server (start with --allow-writes to enable)",
        },
      ],
    };
  }
  const engineClient = new EngineClient({
    tenant_id: p.principal.tenant_id,
    actor_id: p.principal.id,
    actor_type: p.principal.kind === "user" ? "user" : "system_account",
    db: p.db,
  });
  const ctx: ToolContext = {
    db: p.db,
    tenant_id: p.principal.tenant_id,
    conversation_id: `mcp-${crypto.randomUUID()}`,
    actor_id: p.principal.id,
    connector_id: null,
    workflow_id: null,
    engineClient,
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
    // Forward tool progress emissions into MCP progress notifications
    // when the caller supplied a progressToken. Fractional progress is
    // best-effort — tools don't know how many steps remain, so every
    // intermediate emission reports 0.5 and the wrapper's final frame
    // supplies 1.0.
    ...(p.onProgress
      ? {
          onLog: (level, message) => {
            void p.onProgress?.(0.5, `[${level}] ${message}`);
          },
        }
      : {}),
  };
  try {
    const result = await tool.execute(ctx, p.args);
    return {
      isError: !result.ok,
      content: [{ type: "text", text: JSON.stringify(result.data) }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { isError: true, content: [{ type: "text", text: `tool error: ${msg}` }] };
  }
}
