import { getConnector } from "../../connectors/index.ts";
import {
  describeLocalCommand,
  isConfirmedLocalCommand,
  LOCAL_COMMAND_CONFIRMATION_KEYS,
  literalCommandLine,
  localCommandFingerprint,
  mcpConfigBlock,
  readLocalCommand,
} from "../local-command.ts";
import type { ConnectorDraftDocument } from "../types.ts";
import { pauseForUserInput } from "./ask-user/common.ts";
import type { ToolContext, ToolResult } from "./index.ts";

export type LocalCommandGate =
  | { kind: "proceed"; confirmation: Record<string, unknown> }
  | { kind: "stop"; result: ToolResult };

export const MCP_LOCAL_COMMAND_CONFIRM_KIND = "mcp_local_command";

export async function gateLocalCommandProbe(
  ctx: ToolContext,
  connector: ConnectorDraftDocument,
  probeArgs: Record<string, unknown>,
): Promise<LocalCommandGate> {
  const spec = readLocalCommand(connector.config);
  if (!spec) {
    return {
      kind: "stop",
      result: {
        ok: false,
        error_code: "mcp_local_command_missing",
        message:
          "This MCP draft uses transport stdio but has no command. Set config.mcp.command (and args) with update_connector_draft, then probe again.",
        next_best_actions: ["update_connector_draft"],
      },
    };
  }
  if (connector.saved_connector_id) {
    const row = await getConnector(ctx.tenant_id, connector.saved_connector_id, ctx.db);
    const rowConfig = (row?.config ?? null) as Record<string, unknown> | null;
    if (row && isConfirmedLocalCommand(rowConfig, spec)) {
      const rowMcp = mcpConfigBlock(rowConfig) ?? {};
      const confirmation: Record<string, unknown> = {};
      for (const key of LOCAL_COMMAND_CONFIRMATION_KEYS) {
        if (rowMcp[key] !== undefined) confirmation[key] = rowMcp[key];
      }
      return { kind: "proceed", confirmation };
    }
  }
  const literal = literalCommandLine(spec);
  const details = describeLocalCommand(spec);
  const name = connector.name ?? connector.slug ?? "this connector";
  const question = `Allow SubKit to start this local command for “${name}”?\n\n${details}\n\nThe command runs on this computer with your user rights. SubKit asks again whenever the command, its arguments, environment or working folder change.`;
  const result = await pauseForUserInput(ctx, {
    tool_name: "ask_user_confirm",
    summary: question,
    input: {
      question,
      kind: MCP_LOCAL_COMMAND_CONFIRM_KIND,
      summary: `Start local command: ${literal}`,
      destructive: true,
      default: "reject",
      target: {
        connector_name: name,
        command: spec.command,
        args: spec.args,
        command_line: literal,
        env_names: spec.env_names,
        env_secret_names: spec.env_secret_names,
        cwd: spec.cwd,
      },
      commit_intent: {
        kind: "confirm_local_command",
        payload: { command_sha256: localCommandFingerprint(spec), probe_args: probeArgs },
        description: `Allow and start the local command ${literal}, then probe the connector.`,
      },
    },
  });
  return { kind: "stop", result };
}
