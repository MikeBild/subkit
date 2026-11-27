import { stdioConfirmationFromConfig, stdioSpecFromConfig } from "@shared/stdio-identity.ts";
import { AuditAction, type AuditActorType, auditAwait } from "../audit/index.ts";
import { currentDeploymentMode } from "../config/index.ts";
import type { Executor } from "../db/index.ts";
import type { StdioCommandDisplay } from "../mcp/index.ts";
import { emitResourceChange } from "../pubsub/index.ts";
import {
  lockLiveConnector,
  readMcpConnectorConfig,
  storeLocalCommandConfirmation,
} from "./persistence/local-command.ts";

export type LocalCommandConfirmErrorCode =
  | "not_found"
  | "not_stdio"
  | "command_changed"
  | "self_confirmation";

export class LocalCommandConfirmError extends Error {
  constructor(
    readonly code: LocalCommandConfirmErrorCode,
    message: string,
    readonly command: StdioCommandDisplay | null = null,
  ) {
    super(message);
    this.name = "LocalCommandConfirmError";
  }
}

export interface LocalCommandPrincipal {
  id: string;
  kind: AuditActorType;
}

export interface ConfirmLocalCommandResult {
  connector_id: string;
  command: StdioCommandDisplay;
  confirmed_by: string;
  confirmed_at: string;
  already_confirmed: boolean;
}

export async function describeLocalCommand(
  db: Executor,
  tenant_id: string,
  connector_id: string,
): Promise<{ command: StdioCommandDisplay; confirmed: boolean } | null> {
  const row = await readMcpConnectorConfig(db, tenant_id, connector_id);
  const spec = row ? stdioSpecFromConfig(row.config) : null;
  if (!spec) return null;
  const { stdioCommandDisplay } = await import("../mcp/index.ts");
  const command = stdioCommandDisplay(spec);
  return {
    command,
    confirmed:
      stdioConfirmationFromConfig(row?.config).confirmed_command_hash === command.command_hash,
  };
}

export async function confirmLocalCommand(
  db: Executor,
  tenant_id: string,
  connector_id: string,
  principal: LocalCommandPrincipal,
  expected_command_hash: string,
): Promise<ConfirmLocalCommandResult> {
  const { evictServer, stdioCommandDisplay } = await import("../mcp/index.ts");
  const result = await db.transaction(async (tx) => {
    const row = await lockLiveConnector(tx, tenant_id, connector_id);
    if (!row) throw new LocalCommandConfirmError("not_found", "connector not found");
    const spec = row.driver === "mcp" ? stdioSpecFromConfig(row.config) : null;
    if (!spec) {
      throw new LocalCommandConfirmError(
        "not_stdio",
        "this connector starts no local command; only stdio MCP connectors need a confirmation",
      );
    }
    const command = stdioCommandDisplay(spec);
    if (command.command_hash !== expected_command_hash) {
      throw new LocalCommandConfirmError(
        "command_changed",
        "the command changed after it was shown to you; review the current command and confirm again",
        command,
      );
    }
    const prior = stdioConfirmationFromConfig(row.config);
    if (prior.confirmed_command_hash === command.command_hash && prior.confirmed_by) {
      return {
        connector_id,
        command,
        confirmed_by: prior.confirmed_by,
        confirmed_at: prior.confirmed_at ?? new Date().toISOString(),
        already_confirmed: true,
      };
    }
    if (prior.command_set_by === principal.id && currentDeploymentMode() !== "local_workspace") {
      throw new LocalCommandConfirmError(
        "self_confirmation",
        "you entered or changed this command, so another person with permission to confirm local commands has to confirm it",
        command,
      );
    }
    const confirmed_at = new Date().toISOString();
    const config = (row.config ?? {}) as Record<string, unknown>;
    const mcp = (config.mcp ?? {}) as Record<string, unknown>;
    await storeLocalCommandConfirmation(tx, tenant_id, connector_id, {
      ...config,
      mcp: {
        ...mcp,
        confirmed_command_hash: command.command_hash,
        confirmed_by: principal.id,
        confirmed_at,
      },
    });
    await auditAwait(
      {
        tenant_id,
        actor_type: principal.kind,
        actor_id: principal.id,
        action: AuditAction.CONNECTOR_LOCAL_COMMAND_CONFIRMED,
        resource_type: "connector",
        resource_id: connector_id,
        result: "success",
        metadata: {
          slug: row.slug,
          command_hash: command.command_hash,
          command_line: command.command_line,
          env_names: command.env_names,
          env_secret_names: command.env_secret_names,
          cwd: command.cwd,
        },
      },
      tx,
    );
    await emitResourceChange(tx, {
      tenant_id,
      type: "connector.updated",
      ids: { connector_id },
    });
    return {
      connector_id,
      command,
      confirmed_by: principal.id,
      confirmed_at,
      already_confirmed: false,
    };
  });
  if (!result.already_confirmed) evictServer(tenant_id, connector_id);
  return result;
}
