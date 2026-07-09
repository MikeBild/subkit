// StaticToolProvider — TRULY MCP-unique tools that have no
// ConversationTool counterpart. Four entries today:
//
//   authenticate       — OAuth2 reauth-URL provider; MCP-specific
//                        envelope (no conversation analog). Now audits
//                        via CONNECTOR_REAUTH_REQUESTED.
//   list_recipes       — recipe-catalog browse; conversation registry
//                        has inspect_recipe but not list_recipes.
//   find_tool          — keyword search over the FULL registry for the
//                        caller's MCP mode; the discovery bridge for the
//                        long tail the budget-fitted tools/list omits.
//   self_healing.scan  — admin-only LLM repair trigger; MCP-only.
//
// All other "MCP-native" handlers are duplicates of conversation tools
// with the same name; the conversation versions win and serve both
// surfaces through the unified dispatcher.
//
// RBAC + category model for static tools:
//
//   authenticate / list_recipes / find_tool / self_healing.scan — all
//   currently declared as `tenant_read` so the unified policy gate does
//   NOT demand a confirm round-trip. Reasoning per tool:
//
//   - authenticate: one-shot OAuth handshake that returns a portal
//     URL. The handler audits via CONNECTOR_REAUTH_REQUESTED for
//     state-change observability; demanding confirm on every
//     authentication call would break MCP clients (they'd loop on
//     needs_confirm with no human in the loop).
//   - list_recipes: pure catalog read.
//   - find_tool: pure read over tool METADATA the caller can already
//     see (the registry filter scopes results to the caller's own mode
//     and read-only flag). No tenant data, no state change — so no
//     audit row and no confirm gate, same stance as list_recipes.
//   - self_healing.scan: gated by the in-handler
//     `principal.roles.includes("admin")` check + the
//     `mcpMode: ["admin"]` visibility filter here; both defenses
//     are load-bearing. The category label is `tenant_read` so the
//     policy gate stays out of the way; the role check IS the
//     authorization.
//
// Follow-up: when the permission catalog gains
// `connector:authenticate` and `self_healing:run`, recategorize
// these as `tenant_write` and add a descriptor.rbac so the dispatcher
// enforces uniformly. The classification mismatch (state-change
// without policy-gate confirm) is intentional today, not an
// oversight.

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import {
  AUTHENTICATE_TOOL_NAME,
  authenticateTool,
  handleAuthenticate,
} from "../../mcp/tools/authenticate.ts";
import { FIND_TOOL_TOOL_NAME, findToolMcpTool, handleFindTool } from "../../mcp/tools/find-tool.ts";
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
import type { ToolListFilter, ToolProvider, ToolRegistry } from "../registry.ts";
import type { ToolCategory, ToolDescriptor, ToolEnvelope } from "../types.ts";

export interface StaticExecuteCtx {
  readonly db: Db;
  readonly principal: ResolvedPrincipal;
  /** The registry that resolved this call — lets a catalog meta-tool
   *  (find_tool) enumerate the caller-visible tool set without importing
   *  the registry singleton (which would cycle back into this module). */
  readonly registry: ToolRegistry;
  /** MCP mode of this dispatch, threaded from the dispatcher exactly like
   *  every other MCP-dispatched tool receives it. Absent off the MCP
   *  surface; handlers fall back to `resolveMcpMode(principal)`. */
  readonly mcpMode?: "product" | "authoring" | "admin";
  /** Read-only flag of this dispatch (mode + deployment `mcp.read_only`). */
  readonly readOnly?: boolean;
}

export type StaticInvoke = (
  ctx: StaticExecuteCtx,
  args: Record<string, unknown>,
) => Promise<ToolEnvelope>;

interface StaticEntry {
  readonly tool: Tool;
  /** Which MCP modes see this tool. `null` means every mode. */
  readonly visibleInMcpModes: ReadonlyArray<"product" | "authoring" | "admin"> | null;
  /** Whether this tool surfaces on the chat surface. */
  readonly visibleOnChat: boolean;
  /** Category drives the policy gate. See the file header for the
   *  deliberate `tenant_read` labeling on state-changing entries
   *  (authenticate, self_healing.scan): those tools have in-handler
   *  audit + RBAC defenses, and changing the category would demand
   *  a confirm round-trip MCP callers don't expect today. The field
   *  exists so any FUTURE static tool with proper write semantics
   *  can be labeled `tenant_write` and pick up the policy gate
   *  uniformly. */
  readonly category: ToolCategory;
  /** Optional descriptor-level RBAC declaration. When set, the
   *  dispatcher evaluates `can()` before invoking the executor. */
  readonly rbac?: NonNullable<ToolDescriptor["rbac"]>;
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
    // tenant_read for policy purposes (see header). Handler audits
    // the state change via CONNECTOR_REAUTH_REQUESTED. RBAC is
    // enforced centrally: connector:oauth on the target connector id.
    category: "tenant_read",
    rbac: {
      permission: "connector:oauth",
      resource: (args) => {
        const id = (args as { connector_id?: unknown }).connector_id;
        return typeof id === "string" && id.length > 0 ? { type: "connector", id } : null;
      },
    },
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
    // tenant_read: pure catalog browse, no state mutation.
    category: "tenant_read",
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
    // Visible in EVERY mode: MCP_CORE_TOOL_NAMES (mode-resolver.ts) makes
    // find_tool part of the never-trimmed catalog floor, and the floor
    // assertion in capabilities/tools.ts holds for every mode — so hiding
    // it from product would fire a floor_violation warning on every
    // product tools/list. The registry filter inside the handler scopes
    // results to the caller's own mode, so a product caller can only ever
    // discover the product-callable set; visibility here widens nothing.
    tool: findToolMcpTool,
    visibleInMcpModes: null,
    visibleOnChat: false,
    // tenant_read: pure read over tool metadata the caller can already
    // see — no tenant data, no state change, so no audit row beyond the
    // standard tool.dispatch.invoke log (match list_recipes), and the
    // policy gate must not demand a confirm for a catalog search.
    category: "tenant_read",
    async invoke(ctx, args) {
      const result = handleFindTool(ctx, args);
      if (result.ok) return envelopeForOk(result.data);
      return envelopeForError("find_tool_failed", result.data.error, result.data);
    },
  },
  {
    tool: selfHealingScanMcpTool,
    visibleInMcpModes: ["admin"],
    visibleOnChat: false,
    // tenant_read for policy purposes (see header). Authorization
    // gate is the in-handler `principal.roles.includes("admin")`
    // check; visibility (`mcpMode: ["admin"]`) is defense-in-depth.
    category: "tenant_read",
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

function descriptorOf(entry: StaticEntry): ToolDescriptor {
  return {
    name: entry.tool.name,
    description: entry.tool.description ?? "",
    category: entry.category,
    inputSchema: entry.tool.inputSchema,
    ...(entry.rbac ? { rbac: entry.rbac } : {}),
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
      out.push(descriptorOf(e));
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
    return { descriptor: descriptorOf(e), executor: entry };
  },
};

export {
  AUTHENTICATE_TOOL_NAME,
  FIND_TOOL_TOOL_NAME,
  LIST_RECIPES_TOOL_NAME,
  SELF_HEALING_SCAN_TOOL_NAME,
};
