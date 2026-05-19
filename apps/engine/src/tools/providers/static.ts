// StaticToolProvider — TRULY MCP-unique tools that have no
// ConversationTool counterpart. Three entries today:
//
//   authenticate       — OAuth2 reauth-URL provider; MCP-specific
//                        envelope (no conversation analog). Now audits
//                        via CONNECTOR_REAUTH_REQUESTED.
//   list_recipes       — recipe-catalog browse; conversation registry
//                        has inspect_recipe but not list_recipes.
//   self_healing.scan  — admin-only LLM repair trigger; MCP-only.
//
// All other "MCP-native" handlers are duplicates of conversation tools
// with the same name; the conversation versions win and serve both
// surfaces through the unified dispatcher.
//
// RBAC for static tools:
//   - authenticate / list_recipes have no per-tool permission gate
//     today (they are product-tier read-shaped operations). Tenant
//     isolation is enforced via `principal.tenant_id` inside each
//     handler.
//   - self_healing.scan is gated by TWO defenses: visibility limited
//     to `mcpMode: ["admin"]` here (so it's absent from product and
//     authoring catalogs), AND a `principal.roles.includes("admin")`
//     check inside the handler (defense-in-depth). A future
//     `self_healing:run` permission would let it flow through the
//     dispatcher's descriptor.rbac path uniformly.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import {
  AUTHENTICATE_TOOL_NAME,
  authenticateTool,
  handleAuthenticate,
} from "../../mcp/tools/authenticate.ts";
import {
  handleListRecipes,
  LIST_RECIPES_TOOL_NAME,
  listRecipesMcpTool,
} from "../../mcp/tools/recipes.ts";
import {
  handleSelfHealingScan,
  SELF_HEALING_SCAN_TOOL_NAME,
  selfHealingScanMcpTool,
} from "../../mcp/tools/self-healing-scan.ts";
import type { ToolListFilter, ToolProvider } from "../registry.ts";
import type { ToolDescriptor, ToolEnvelope } from "../types.ts";

export interface StaticExecuteCtx {
  readonly db: Db;
  readonly principal: ResolvedPrincipal;
}

export type StaticInvoke = (
  ctx: StaticExecuteCtx,
  args: Record<string, unknown>,
) => Promise<ToolEnvelope>;

interface StaticEntry {
  readonly tool: Tool;
  /** Which MCP modes see this tool. `null` means every mode. */
  readonly visibleInMcpModes: ReadonlyArray<"product" | "authoring" | "admin"> | null;
  /** Whether this tool surfaces on the chat surface. `authenticate` and
   *  `self_healing.scan` are MCP-only; `list_recipes` arguably useful in
   *  chat too but currently only registered MCP-side. */
  readonly visibleOnChat: boolean;
  /** Invoker — wraps each handler in the unified envelope shape so the
   *  dispatcher's normalize step is total. */
  readonly invoke: StaticInvoke;
}

function envelopeForOk(data: unknown): ToolEnvelope {
  return { status: "ok", data };
}

function envelopeForError(error_code: string, message: string, details?: unknown): ToolEnvelope {
  return { status: "error", error_code, message, ...(details !== undefined ? { details } : {}) };
}

const STATIC_ENTRIES: ReadonlyArray<StaticEntry> = [
  {
    tool: authenticateTool,
    visibleInMcpModes: null,
    visibleOnChat: false,
    async invoke(ctx, args) {
      const result = await handleAuthenticate(
        { db: ctx.db, principal: ctx.principal },
        args as Parameters<typeof handleAuthenticate>[1],
      );
      if (result.ok) return envelopeForOk(result.data);
      return envelopeForError("authenticate_failed", JSON.stringify(result.data), result.data);
    },
  },
  {
    tool: listRecipesMcpTool,
    visibleInMcpModes: null,
    visibleOnChat: false,
    async invoke(ctx, args) {
      const result = await handleListRecipes(
        { db: ctx.db, principal: ctx.principal },
        args as unknown as Parameters<typeof handleListRecipes>[1],
      );
      if (result.ok) return envelopeForOk(result.data);
      const errMsg =
        typeof (result.data as { error?: unknown })?.error === "string"
          ? (result.data as { error: string }).error
          : "list_recipes_failed";
      return envelopeForError("list_recipes_failed", errMsg, result.data);
    },
  },
  {
    tool: selfHealingScanMcpTool,
    visibleInMcpModes: ["admin"],
    visibleOnChat: false,
    async invoke(ctx, args) {
      const result = await handleSelfHealingScan(
        { db: ctx.db, principal: ctx.principal },
        args as Parameters<typeof handleSelfHealingScan>[1],
      );
      if (result.ok) return envelopeForOk(result.data);
      const errMsg =
        typeof (result.data as { error?: unknown })?.error === "string"
          ? (result.data as { error: string }).error
          : "self_healing_scan_failed";
      return envelopeForError("self_healing_scan_failed", errMsg, result.data);
    },
  },
];

export interface StaticProviderEntry {
  readonly kind: "static";
  readonly tool: Tool;
  readonly toolName: string;
  readonly invoke: StaticInvoke;
}

function descriptorOf(tool: Tool): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description ?? "",
    category: "tenant_read",
    inputSchema: tool.inputSchema,
  };
}

function isVisible(entry: StaticEntry, filter: ToolListFilter): boolean {
  if (filter.surface === "chat") return entry.visibleOnChat;
  if (entry.visibleInMcpModes === null) return true;
  if (filter.mcpMode === undefined) return false;
  return entry.visibleInMcpModes.includes(filter.mcpMode);
}

export const staticToolProvider: ToolProvider = {
  name: "StaticToolProvider",
  list(filter) {
    const out: ToolDescriptor[] = [];
    for (const e of STATIC_ENTRIES) {
      if (!isVisible(e, filter)) continue;
      out.push(descriptorOf(e.tool));
    }
    return out;
  },
  resolve(name, filter) {
    const e = STATIC_ENTRIES.find((x) => x.tool.name === name);
    if (!e) return undefined;
    if (!isVisible(e, filter)) return undefined;
    const entry: StaticProviderEntry = {
      kind: "static",
      tool: e.tool,
      toolName: e.tool.name,
      invoke: e.invoke,
    };
    return { descriptor: descriptorOf(e.tool), executor: entry };
  },
};

export { AUTHENTICATE_TOOL_NAME, LIST_RECIPES_TOOL_NAME, SELF_HEALING_SCAN_TOOL_NAME };
