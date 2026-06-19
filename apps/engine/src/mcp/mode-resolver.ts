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

import type { ResolvedPrincipal } from "../auth/types.ts";

export type McpMode = "product" | "authoring" | "admin";

const MCP_ADMIN_SCOPE = "mcp:admin";
const MCP_AUTHORING_SCOPE = "mcp:authoring";

/** Env override used in tests and local dev where attaching scopes to
 *  every principal is annoying. Accepts `product` / `authoring` / `admin`
 *  and forces every MCP session into that mode regardless of scope. */
const ENV_OVERRIDE_NAME = "SK_MCP_MODE";

function readEnvOverride(): McpMode | null {
  const v = process.env[ENV_OVERRIDE_NAME];
  if (v === "product" || v === "authoring" || v === "admin") return v;
  return null;
}

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
