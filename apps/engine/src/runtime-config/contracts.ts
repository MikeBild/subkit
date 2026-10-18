import { hostname } from "node:os";

export const CONFIG_STATE_KEY = "runtime";
export const REPLICA_HEARTBEAT_MS = 10_000;
export const REPLICA_LEASE_MS = 30_000;
export const ACTIVATION_TIMEOUT_MS = 60_000;

export function defaultReplicaInstanceId(): string {
  return process.env.SUBKIT_REPLICA_ID || `${hostname()}-${process.pid}`;
}

export type RevisionStatus = "saved" | "preparing" | "active" | "failed" | "restart_required";

export interface RuntimeRevision {
  revision: number;
  document: Record<string, unknown>;
  digest: string;
  status: RevisionStatus;
  pending_restart_fields: string[];
  failure_reason: string | null;
  created_at: Date;
  activated_at: Date | null;
}

export interface RuntimeConfigStateView {
  saved_revision: number;
  active_revision: number;
  activation_status: RevisionStatus;
  pending_restart_fields: string[];
}

export class RuntimeConfigConflictError extends Error {
  readonly code = "revision_conflict";
}

export class RuntimeConfigValidationError extends Error {
  readonly code = "validation_failed";
}

export class RuntimeConfigNotFoundError extends Error {
  readonly code = "not_found";
}

export class RuntimeSecretInUseError extends Error {
  readonly code = "secret_in_use";
}

export const OPERATOR_CHANGE_PENDING_MESSAGE =
  "The engine operator has saved engine-wide settings that are not active yet. Your workspace setting was not saved. Try again after the operator activates them or restarts the engine.";

export class RuntimeConfigPendingError extends Error {
  readonly code = "operator_change_pending";
  constructor(message = OPERATOR_CHANGE_PENDING_MESSAGE) {
    super(message);
  }
}
