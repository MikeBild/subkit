import { randomUUID } from "node:crypto";
import { eq, gte } from "drizzle-orm";
import { AuditAction, auditAwait } from "../audit/index.ts";
import type { Db, Executor } from "../db/client.ts";
import {
  type EngineRestartRequest,
  engineRestartRequests,
  runtimeConfigReplicas,
  runtimeConfigState,
} from "../db/schema/index.ts";
import { logger } from "../logging/index.ts";
import { CONFIG_STATE_KEY, REPLICA_LEASE_MS, type RevisionStatus } from "./contracts.ts";
import { getRuntimeRevision } from "./service.ts";
import { runtimeStateColumns } from "./state-columns.ts";

export const ENGINE_RESTART_EXIT_CODE = 75;
export const RESTART_MIN_INTERVAL_MS = 60_000;
export const RESTART_IN_PROGRESS_MS = 5 * 60_000;

export type ShutdownReason = "signal" | "restart" | "timeout";

export function shutdownExitCode(reason: ShutdownReason): number {
  switch (reason) {
    case "restart":
      return ENGINE_RESTART_EXIT_CODE;
    case "timeout":
      return 1;
    case "signal":
      return 0;
  }
}

const BOOT = { id: randomUUID(), started_at: new Date() };

export function bootIdentity(): { id: string; started_at: Date } {
  return BOOT;
}

let restartTrigger: (() => void) | null = null;

export function registerRestartTrigger(trigger: () => void): () => void {
  restartTrigger = trigger;
  return () => {
    if (restartTrigger === trigger) restartTrigger = null;
  };
}

export function restartArmed(): boolean {
  return restartTrigger !== null;
}

export function scheduleProcessRestart(delayMs = 250): boolean {
  const trigger = restartTrigger;
  if (!trigger) return false;
  setTimeout(trigger, delayMs);
  return true;
}

export type RestartRefusal =
  | "not_supervised"
  | "nothing_pending"
  | "multiple_replicas"
  | "restart_in_progress"
  | "not_ready";

const REFUSAL_MESSAGES: Record<RestartRefusal, string> = {
  not_supervised:
    "server.restart_supervised is off: no supervisor is known to start the engine again, so it does not end itself",
  nothing_pending: "no saved setting is waiting for a restart",
  multiple_replicas:
    "more than one engine instance is live; restart them one after another from the process supervisor",
  restart_in_progress: "a restart was requested a moment ago; wait for it to finish",
  not_ready: "this engine is still starting and cannot restart yet; try again in a moment",
};

export class EngineRestartRefusedError extends Error {
  constructor(readonly code: RestartRefusal) {
    super(REFUSAL_MESSAGES[code]);
  }
}

export interface RestartStatus {
  boot_id: string;
  started_at: string;
  saved_revision: number;
  active_revision: number;
  activation_status: RevisionStatus;
  restart_supervised: boolean;
  pending_restart_fields: string[];
}

function supervisedIn(document: Record<string, unknown>): boolean {
  const server = document.server;
  return (
    server !== null &&
    typeof server === "object" &&
    (server as Record<string, unknown>).restart_supervised === true
  );
}

async function lockedState(tx: Executor) {
  // tenant-filter:exempt — the canonical active/desired pointer is product-global.
  const [state] = await tx
    .select(runtimeStateColumns)
    .from(runtimeConfigState)
    .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY))
    .for("update");
  if (!state?.active_revision) throw new Error("runtime config is not initialized");
  return { ...state, active_revision: state.active_revision };
}

const RESTART_REQUEST_KEY = "engine";

async function readRestartRequest(tx: Executor): Promise<EngineRestartRequest | null> {
  // tenant-filter:exempt — the restart request is product-global engine state.
  const [row] = await tx
    .select({ request: engineRestartRequests.request })
    .from(engineRestartRequests)
    .where(eq(engineRestartRequests.key, RESTART_REQUEST_KEY))
    .limit(1);
  return row?.request ?? null;
}

async function writeRestartRequest(tx: Executor, request: EngineRestartRequest): Promise<void> {
  const now = new Date();
  await tx
    .insert(engineRestartRequests)
    .values({ key: RESTART_REQUEST_KEY, request, updated_at: now })
    .onConflictDoUpdate({
      target: engineRestartRequests.key,
      set: { request, updated_at: now },
    });
}

export async function getRestartStatus(db: Executor): Promise<RestartStatus> {
  // tenant-filter:exempt — the canonical active/desired pointer is product-global.
  const [state] = await db
    .select(runtimeStateColumns)
    .from(runtimeConfigState)
    .where(eq(runtimeConfigState.key, CONFIG_STATE_KEY))
    .limit(1);
  if (!state?.active_revision) throw new Error("runtime config is not initialized");
  const savedRevision = state.desired_revision ?? state.active_revision;
  const saved = await getRuntimeRevision(db, savedRevision);
  return {
    boot_id: BOOT.id,
    started_at: BOOT.started_at.toISOString(),
    saved_revision: saved.revision,
    active_revision: state.active_revision,
    activation_status: saved.status,
    restart_supervised: supervisedIn(saved.document),
    pending_restart_fields:
      saved.revision === state.active_revision ? [] : saved.pending_restart_fields,
  };
}

export interface RestartRequester {
  tenant_id: string;
  actor_type: "user" | "system_account";
  actor_id: string;
}

export async function requestEngineRestart(
  db: Db,
  requester: RestartRequester,
  now: Date = new Date(),
): Promise<{ request_id: string; audit_id: string; boot_id: string; expected_revision: number }> {
  return db.transaction(async (tx) => {
    const state = await lockedState(tx);
    const savedRevision = state.desired_revision ?? state.active_revision;
    const saved = await getRuntimeRevision(tx, savedRevision);
    if (!supervisedIn(saved.document)) throw new EngineRestartRefusedError("not_supervised");
    if (savedRevision === state.active_revision || saved.status !== "restart_required") {
      throw new EngineRestartRefusedError("nothing_pending");
    }
    const cutoff = new Date(now.getTime() - REPLICA_LEASE_MS);
    // tenant-filter:exempt — replica leases are product-global runtime state.
    const live = await tx
      .select({ instance_id: runtimeConfigReplicas.instance_id })
      .from(runtimeConfigReplicas)
      .where(gte(runtimeConfigReplicas.last_seen_at, cutoff))
      .limit(2);
    if (live.length > 1) throw new EngineRestartRefusedError("multiple_replicas");
    const previous = await readRestartRequest(tx);
    if (previous) {
      const age = now.getTime() - Date.parse(previous.requested_at);
      const open = !previous.outcome;
      if (
        age < RESTART_MIN_INTERVAL_MS ||
        (open && (previous.from_boot_id === BOOT.id || age < RESTART_IN_PROGRESS_MS))
      ) {
        throw new EngineRestartRefusedError("restart_in_progress");
      }
    }
    if (!restartArmed()) throw new EngineRestartRefusedError("not_ready");
    const requestId = randomUUID();
    const audited = await auditAwait(
      {
        tenant_id: requester.tenant_id,
        actor_type: requester.actor_type,
        actor_id: requester.actor_id,
        action: AuditAction.ENGINE_RESTART_REQUESTED,
        resource_type: "engine",
        resource_id: requestId,
        metadata: {
          boot_id: BOOT.id,
          saved_revision: savedRevision,
          active_revision: state.active_revision,
          pending_restart_fields: saved.pending_restart_fields,
        },
      },
      tx,
    );
    const request: EngineRestartRequest = {
      request_id: requestId,
      audit_id: audited.id,
      tenant_id: requester.tenant_id,
      actor_type: requester.actor_type,
      actor_id: requester.actor_id,
      from_boot_id: BOOT.id,
      expected_revision: savedRevision,
      requested_at: now.toISOString(),
    };
    await writeRestartRequest(tx, request);
    return {
      request_id: requestId,
      audit_id: audited.id,
      boot_id: BOOT.id,
      expected_revision: savedRevision,
    };
  });
}

export async function recordRestartOutcomeAtBoot(
  db: Db,
): Promise<{ outcome: "completed" | "failed"; request_id: string } | null> {
  const result = await db.transaction(async (tx) => {
    const state = await lockedState(tx);
    const request = await readRestartRequest(tx);
    if (!request || request.outcome || request.from_boot_id === BOOT.id) return null;
    const completed = state.active_revision >= request.expected_revision;
    const expected = completed
      ? null
      : await getRuntimeRevision(tx, request.expected_revision).catch(() => null);
    const outcome = completed ? ("completed" as const) : ("failed" as const);
    const closedAt = new Date();
    await auditAwait(
      {
        tenant_id: request.tenant_id,
        actor_type: "system",
        action: completed
          ? AuditAction.ENGINE_RESTART_COMPLETED
          : AuditAction.ENGINE_RESTART_FAILED,
        resource_type: "engine",
        resource_id: request.request_id,
        result: completed ? "success" : "error",
        reason: completed
          ? null
          : `revision ${request.expected_revision} did not become active (${expected?.status ?? "unknown"}${expected?.failure_reason ? `: ${expected.failure_reason}` : ""})`,
        metadata: {
          requested_audit_id: request.audit_id,
          requested_by: request.actor_id,
          requested_at: request.requested_at,
          from_boot_id: request.from_boot_id,
          boot_id: BOOT.id,
          expected_revision: request.expected_revision,
          active_revision: state.active_revision,
        },
      },
      tx,
    );
    await writeRestartRequest(tx, {
      ...request,
      outcome,
      closed_at: closedAt.toISOString(),
      to_boot_id: BOOT.id,
    });
    return { outcome, request_id: request.request_id };
  });
  if (result) {
    logger.info({
      module: "runtime_config",
      action: `engine.restart.${result.outcome}`,
      msg: "restart request answered at boot",
      request_id: result.request_id,
    });
  }
  return result;
}

export async function answerRestartRequestAtBoot(db: Db): Promise<void> {
  try {
    await recordRestartOutcomeAtBoot(db);
  } catch (error) {
    logger.error({
      module: "runtime_config",
      action: "engine.restart.outcome_failed",
      msg: "could not record the outcome of the requested restart",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
