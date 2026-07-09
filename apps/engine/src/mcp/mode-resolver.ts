// MCP catalog mode resolver.
//
// The product-level MCP surface in subkit shows two kinds of tools only:
//   • saved workflow tools (`wf.<slug>`)
//   • the generic `authenticate` tool
//
// Conversation-authoring tools (`conversation.*`) and tenant-admin tools
// (`tenant.*`) are opt-in and only appear when the caller's principal
// carries the right scope. This keeps the default MCP experience clean
// and keeps the rich authoring/admin surface available for callers that
// explicitly ask for it.

import { MCP_ADMIN_SCOPE, MCP_AUTHORING_SCOPE } from "../auth/scopes.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";

export type McpMode = "product" | "authoring" | "admin";

/** Env override used in tests and local dev where attaching scopes to
 *  every principal is annoying. Accepts `product` / `authoring` / `admin`
 *  and forces every MCP session into that mode regardless of scope. */
const ENV_OVERRIDE_NAME = "SK_MCP_MODE";

function readEnvOverride(): McpMode | null {
  const v = process.env[ENV_OVERRIDE_NAME];
  if (v === "product" || v === "authoring" || v === "admin") return v;
  return null;
}

// Note (mcp-spec): MCP scopes here gate tool VISIBILITY only — a lower-scope
// principal simply sees a smaller catalog, it is never denied a call it could
// otherwise make. So the 2025-11-25 `insufficient_scope` step-up challenge
// (SEP-835) has no trigger point in this model and is intentionally NOT
// implemented; adding a 403 WWW-Authenticate challenge would be dead code.
export function resolveMcpMode(principal: ResolvedPrincipal): McpMode {
  const env = readEnvOverride();
  if (env) return env;
  const scopes = principal.scopes ?? [];
  if (scopes.includes(MCP_ADMIN_SCOPE)) return "admin";
  if (scopes.includes(MCP_AUTHORING_SCOPE)) return "authoring";
  return "product";
}

/** The `tools/list` payload is shaped by the resolved mode. */
export interface McpModeFlags {
  /** saved workflows + authenticate tool */
  showProductTools: true;
  /** conversation.* tools */
  showConversationTools: boolean;
  /** tenant.* read tools */
  showTenantReads: boolean;
  /** tenant.* write tools */
  showTenantWrites: boolean;
}

export function modeFlags(mode: McpMode, readOnly: boolean): McpModeFlags {
  if (mode === "admin") {
    return {
      showProductTools: true,
      showConversationTools: true,
      showTenantReads: true,
      showTenantWrites: !readOnly,
    };
  }
  if (mode === "authoring") {
    return {
      showProductTools: true,
      showConversationTools: true,
      showTenantReads: true,
      showTenantWrites: false,
    };
  }
  return {
    showProductTools: true,
    showConversationTools: false,
    showTenantReads: false,
    showTenantWrites: false,
  };
}

/** The search-first floor of the `tools/list` catalog. These tools are never
 *  trimmed by the budget-fit cascade, regardless of mode or catalog size, so
 *  that every client can always discover and run the full workflow library on
 *  demand (`find_workflow` → `run_workflow(slug)`), authenticate a connector,
 *  and inspect recipes. `find_tool` extends the same search-first pattern to
 *  the TOOL catalog itself: the budget fit advertises a bounded allow-list, and
 *  find_tool searches the full registry for the caller's mode so the
 *  unadvertised long tail stays discoverable, not merely callable. The
 *  per-workflow `wf_` palette (capped to its Top-N) rides alongside this
 *  floor. */
export const MCP_CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "find_workflow",
  "run_workflow",
  "authenticate",
  "list_recipes",
  "find_tool",
]);
