import { MCP_ADMIN_SCOPE, MCP_AUTHORING_SCOPE } from "../auth/scopes.ts";
import type { ResolvedPrincipal } from "../auth/types.ts";
import { readEnv } from "../env.ts";

export type McpMode = "product" | "authoring" | "admin";

function readEnvOverride(): McpMode | null {
  const v = readEnv("SUBKIT_MCP_MODE");
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

interface McpModeFlags {
  showProductTools: true;
  showConversationTools: boolean;
  showTenantReads: boolean;
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

export const MCP_CORE_TOOL_NAMES: ReadonlySet<string> = new Set([
  "confirm_tool_call",
  "find_workflow",
  "run_workflow",
  "authenticate",
  "list_recipes",
]);
