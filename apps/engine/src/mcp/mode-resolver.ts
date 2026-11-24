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

export const AUTHORING_SCOPE_REQUIRED = "authoring_scope_required";

export const SAVE_TASK_AUTHORING_SCOPE_MESSAGE =
  "Saving a task over MCP needs a credential with the mcp:authoring scope. Without it, tasks can be listed, started and stopped here and are created in the Cockpit.";

export const authoringScopeRequiredMessage = (toolName: string): string =>
  toolName === "save_task"
    ? SAVE_TASK_AUTHORING_SCOPE_MESSAGE
    : `"${toolName}" over MCP needs a credential with the mcp:authoring scope. Reconnect with the Authoring level, or use the Cockpit.`;
