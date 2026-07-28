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

import { MCP_ADMIN_SCOPE, MCP_AUTHORING_SCOPE, WILDCARD_SCOPE } from "../auth/scopes.ts";
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
//
// The wildcard `*` scope asserts "no narrowing — full role-derived access"
// (auth/scopes.ts): it is the default minted key scope, the admin-key scope,
// and the OIDC session scope. Treating it as `product` inverted that contract —
// the LEAST-narrowed credential got the SMALLEST catalog while an OAuth token
// carrying the literal `mcp:authoring` marker got the full one. A wildcard
// principal therefore resolves to `authoring`. It never resolves to `admin`:
// the admin catalog adds tenant writes, and that surface stays opt-in behind
// the explicit `mcp:admin` marker regardless of how broad the credential is.
//
// `modeFlags` below is where that promise is actually kept — authoring pins
// `showTenantWrites: false` unconditionally, so no credential widens it. Verify
// the shape through `modeFlags` → `listToolsViaRegistry`, never by listing the
// conversation provider directly: the provider does not see this flag, so it
// reports authoring and admin as identical when they are not.
export function resolveMcpMode(principal: ResolvedPrincipal): McpMode {
  const env = readEnvOverride();
  if (env) return env;
  const scopes = principal.scopes ?? [];
  if (scopes.includes(MCP_ADMIN_SCOPE)) return "admin";
  if (scopes.includes(MCP_AUTHORING_SCOPE)) return "authoring";
  if (scopes.includes(WILDCARD_SCOPE)) return "authoring";
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

/** The search-first floor of the `tools/list` catalog. These tools must be
 *  present in every mode, regardless of catalog size, so that every client can
 *  always discover and run the full workflow library on demand
 *  (`find_workflow` → `run_workflow(slug)`), authenticate a connector, and
 *  inspect recipes. The per-workflow `wf_` palette (capped to its Top-N) rides
 *  alongside this floor. */
export const MCP_CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "find_workflow",
  "run_workflow",
  "authenticate",
  "list_recipes",
]);
