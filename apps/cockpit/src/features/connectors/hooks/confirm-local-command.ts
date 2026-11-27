import { useMutation } from "@tanstack/react-query";
import { ApiError, apiRequest } from "@/api/client";
import { engineCommandLine, localCommandHash } from "../model/create-connector-model";

export interface ConfirmedCommand {
  connector_id?: string;
  confirmed_at: string;
  already_confirmed?: boolean;
}

export interface LocalCommandTarget {
  id: string;
  config: unknown;
}

const UNKNOWN_HASH = "0".repeat(64);

function post(id: string, commandHash: string): Promise<ConfirmedCommand> {
  return apiRequest<ConfirmedCommand>(
    `/v1/connectors/${encodeURIComponent(id)}/mcp/confirm-command`,
    { method: "POST", body: JSON.stringify({ command_hash: commandHash }) },
  );
}

function engineHash(failure: unknown, expectedLine: string | null): string | null {
  if (!(failure instanceof ApiError) || failure.code !== "mcp_local_command_changed") return null;
  const command = failure.details?.command;
  if (!command || typeof command !== "object") return null;
  const { command_hash: hash, command_line: line } = command as Record<string, unknown>;
  if (typeof hash !== "string" || expectedLine === null || line !== expectedLine) return null;
  return hash;
}

async function browserHash(config: unknown): Promise<string | null> {
  try {
    return await localCommandHash(config);
  } catch {
    return null;
  }
}

export async function confirmLocalCommand(target: LocalCommandTarget): Promise<ConfirmedCommand> {
  const commandHash = await browserHash(target.config);
  if (commandHash) return post(target.id, commandHash);
  try {
    return await post(target.id, UNKNOWN_HASH);
  } catch (failure) {
    const hash = engineHash(failure, engineCommandLine(target.config));
    if (!hash) throw failure;
    return post(target.id, hash);
  }
}

export function useConfirmLocalCommand(options: {
  onSuccess(result: ConfirmedCommand, target: LocalCommandTarget): void | Promise<void>;
  onError?(failure: unknown): void;
}) {
  return useMutation({
    meta: { sensitive: true },
    mutationFn: confirmLocalCommand,
    onSuccess: options.onSuccess,
    ...(options.onError ? { onError: options.onError } : {}),
  });
}
