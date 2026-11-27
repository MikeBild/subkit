import type { ResolvedPrincipal } from "../auth/index.ts";
import { confirmLocalCommand } from "../connectors/index.ts";
import type { Db } from "../db/index.ts";
import { can } from "../rbac/index.ts";
import type { ToolResult } from "./tools/index.ts";

export const CONFIRM_LOCAL_COMMAND_PERMISSION = "connector:confirm_local_command";

export interface LocalCommandConfirmDeps {
  allowed: (p: {
    db: Db;
    tenant_id: string;
    connector_id: string;
    principal: ResolvedPrincipal;
  }) => Promise<boolean>;
  confirm: (
    db: Db,
    tenant_id: string,
    connector_id: string,
    principal: { id: string; kind: "user" },
    expected_command_hash: string,
  ) => Promise<unknown>;
}

const ENGINE_DEPS: LocalCommandConfirmDeps = {
  allowed: async ({ db, tenant_id, connector_id, principal }) =>
    (
      await can(db, {
        tenant_id,
        principal,
        permission: CONFIRM_LOCAL_COMMAND_PERMISSION,
        resource: { type: "connector", id: connector_id },
      })
    ).allow,
  confirm: confirmLocalCommand,
};

let deps: LocalCommandConfirmDeps = ENGINE_DEPS;

export function setLocalCommandConfirmDepsForTests(
  next: Partial<LocalCommandConfirmDeps> | null,
): void {
  deps = next ? { ...ENGINE_DEPS, ...next } : ENGINE_DEPS;
}

export type LocalCommandConfirmOutcome =
  | { ok: true }
  | { ok: false; code: string; message: string };

export async function confirmLocalCommandForConnector(p: {
  db: Db;
  tenant_id: string;
  connector_id: string;
  principal: ResolvedPrincipal;
  expected_command_hash: string;
}): Promise<LocalCommandConfirmOutcome> {
  if (!(await deps.allowed(p))) {
    return {
      ok: false,
      code: "permission_denied",
      message: `you lack the permission ${CONFIRM_LOCAL_COMMAND_PERMISSION}`,
    };
  }
  try {
    await deps.confirm(
      p.db,
      p.tenant_id,
      p.connector_id,
      { id: p.principal.id, kind: "user" },
      p.expected_command_hash,
    );
    return { ok: true };
  } catch (err) {
    const code =
      err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
        ? (err as { code: string }).code
        : "mcp_local_command_unconfirmed";
    return { ok: false, code, message: err instanceof Error ? err.message : String(err) };
  }
}

export const OWNER_MUST_CONFIRM =
  "An owner or admin who did not enter this command must allow it: in the Cockpit open Connectors, select the connector and choose “Allow command”, or answer the confirmation in the chat.";

export function localCommandRefusal(
  error_code: string,
  message: string,
  next_best_actions: string[],
): ToolResult {
  return {
    ok: false,
    error_code,
    message,
    next_best_actions,
    data: { error_code, user_asked: true, confirmed: false },
  };
}

export function localCommandRefusalFor(code: string, engineMessage: string): ToolResult {
  if (code === "mcp_stdio_disabled") {
    return localCommandRefusal(
      code,
      `Nothing was started. Local commands are turned off on this engine (setting connectors.mcp.stdio). An admin can turn them on, or use an http(s) MCP address instead. Engine said: ${engineMessage}`,
      ["update_connector_draft", "cannot_help"],
    );
  }
  if (code === "mcp_stdio_unavailable_in_container") {
    return localCommandRefusal(
      code,
      `Nothing was started. This engine runs in a container and cannot start local commands. Use SubKit Desktop or an engine on the host, or run the MCP server on the host and connect over http://host.docker.internal:<port>/mcp. Engine said: ${engineMessage}`,
      ["update_connector_draft", "cannot_help"],
    );
  }
  if (code === "mcp_stdio_capacity") {
    return localCommandRefusal(
      code,
      `The command is allowed, but the engine already runs as many local MCP servers as it may. Try again in a moment, or ask an admin to raise connectors.mcp.stdio_limits.max_processes. Engine said: ${engineMessage}`,
      ["probe_connector_draft"],
    );
  }
  if (code === "mcp_stdio_start_failed") {
    return localCommandRefusal(
      code,
      `The command is allowed, but it did not start or did not answer the MCP handshake. Check that the program is installed and on PATH, and that its arguments are right. Engine said: ${engineMessage}`,
      ["update_connector_draft", "probe_connector_draft"],
    );
  }
  if (code === "command_changed" || code === "mcp_local_command_changed") {
    return localCommandRefusal(
      "mcp_local_command_changed",
      `Nothing was started. The command changed after it was shown, so the confirmation does not apply. Probe again to ask about the current command. Engine said: ${engineMessage}`,
      ["probe_connector_draft"],
    );
  }
  return localCommandRefusal(
    code,
    `Nothing was started. ${OWNER_MUST_CONFIRM} Engine said: ${engineMessage}`,
    ["cannot_help"],
  );
}
