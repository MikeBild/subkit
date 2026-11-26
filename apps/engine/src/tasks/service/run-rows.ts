import { and, eq, inArray } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction, type AuditActionValue } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { assertInsertRow } from "../../db/assert-insert.ts";
import type { Executor } from "../../db/client.ts";
import { taskRuns, tasks } from "../../db/schema/index.ts";
import { endDeviceSessions } from "../../devices/session-end.ts";
import { NotFoundError } from "../../http/errors.ts";
import { emitResourceChange } from "../../pubsub/resource-changes.ts";
import { now } from "../../utils/clock.ts";
import { normalizeFailureCode } from "../core/failure-codes.ts";
import { withTaskRunAuditTrace } from "../trace.ts";
import { TASK_RUN_OPEN_STATES } from "../types.ts";
import {
  lockTask,
  SYSTEM_ACTOR,
  type TaskActor,
  type TaskEffects,
  type TaskRow,
  type TaskRunRow,
  type TaskRunSettledState,
  type TaskScope,
  type TaskServiceDeps,
  taskVisibility,
} from "./shared.ts";

export type TaskRunSource = "api" | "chat" | "queue" | "scheduler";
export type TaskRunEndReason = "task_changed" | "task_archived" | "owner_unavailable";

const TERMINAL_OUTCOMES = { completed: "completed", failed: "failed", aborted: "aborted" } as const;

export interface TaskRunAudit {
  action: AuditActionValue;
  actor: TaskActor;
  result?: "success" | "error";
  environment?: "dev" | "prod";
  reason_code?: "result_rejected";
  conversation_change?: { previous_conversation_id: string; conversation_id: string };
}

export interface WriteRunOptions {
  at: Date;
  effects: TaskEffects;
  audits?: TaskRunAudit[];
  source?: TaskRunSource | undefined;
  announce?: boolean;
}

function durationMs(run: TaskRunRow, at: Date): number {
  return Math.max(0, at.getTime() - run.created_at.getTime());
}

function auditDetails(
  action: AuditActionValue,
  prior: TaskRunRow,
  run: TaskRunRow,
  at: Date,
  environment: "dev" | "prod" | undefined,
): Record<string, unknown> {
  const ended = {
    previous_state: prior.state,
    turns_used: run.turns_used,
    duration_ms: durationMs(run, at),
  };
  switch (action) {
    case AuditAction.TASK_RUN_STARTED:
      return {
        trigger: run.trigger,
        task_revision: run.task_revision,
        task_grant_id: run.grant_id,
        environment: environment ?? null,
        deadline_at: run.deadline_at.toISOString(),
      };
    case AuditAction.TASK_RUN_WAITING:
      return {
        state: run.state,
        waiting_reason: run.waiting_reason,
        sleep_reason: run.sleep_reason,
        turns_used: run.turns_used,
      };
    case AuditAction.TASK_RUN_RESUMED:
      return {
        previous_state: prior.state,
        resume_reason: prior.waiting_reason ?? prior.sleep_reason ?? "wake",
        turns_used: run.turns_used,
      };
    case AuditAction.TASK_RUN_RESULT_READY:
      return { turns_used: run.turns_used };
    case AuditAction.TASK_RUN_FAILED:
      return { ...ended, failure_code: run.failure_code };
    case AuditAction.TASK_RUN_ABORT_REQUESTED:
      return { previous_state: prior.state };
    case AuditAction.TASK_RUN_ABORTED:
      return { ...ended, reason_code: run.failure_code };
    default:
      return ended;
  }
}

function auditReason(action: AuditActionValue, run: TaskRunRow): string | null {
  if (action === AuditAction.TASK_RUN_WAITING)
    return run.waiting_reason ?? (run.sleep_reason === "paused" ? "paused" : null);
  if (action === AuditAction.TASK_RUN_ABORTED && run.failure_code === "owner_unavailable")
    return "owner_unavailable";
  return null;
}

export async function auditTaskRun(
  tx: Executor,
  prior: TaskRunRow,
  run: TaskRunRow,
  entry: TaskRunAudit,
  options: { at: Date; source?: TaskRunSource | undefined; ts?: Date },
): Promise<void> {
  await withTaskRunAuditTrace(run, () =>
    auditAwait(
      {
        tenant_id: run.tenant_id,
        ...(options.ts ? { ts: options.ts } : {}),
        ...entry.actor,
        action: entry.action,
        resource_type: "task_run",
        resource_id: run.id,
        result: entry.result ?? "success",
        reason: auditReason(entry.action, run),
        trace_id: run.trace_id,
        metadata: {
          task_id: run.task_id,
          task_run_id: run.id,
          ...auditDetails(entry.action, prior, run, options.at, entry.environment),
          ...(entry.reason_code ? { reason_code: entry.reason_code } : {}),
          ...(entry.conversation_change ?? {}),
          ...(options.source ? { request_source: options.source } : {}),
        },
      },
      tx,
    ),
  );
}

export async function announceTaskRun(tx: Executor, run: TaskRunRow): Promise<void> {
  await emitResourceChange(tx, {
    tenant_id: run.tenant_id,
    type: "task_run.changed",
    ids: { task_id: run.task_id, task_run_id: run.id },
  });
  if (!(TASK_RUN_OPEN_STATES as readonly string[]).includes(run.state))
    await endDeviceSessions(tx, run.tenant_id, { task_run_id: run.id });
}

async function emitStateEvent(
  tx: Executor,
  deps: TaskServiceDeps,
  run: TaskRunRow,
  at: Date,
): Promise<void> {
  const ids = { task_run_id: run.id, task_id: run.task_id, trigger: run.trigger };
  if (run.state === "waiting" && run.waiting_reason)
    await deps.emitTaskRunEvent(tx, run.tenant_id, "task_run.waiting", {
      ...ids,
      waiting_reason: run.waiting_reason,
    });
  if (run.state === "result_ready")
    await deps.emitTaskRunEvent(tx, run.tenant_id, "task_run.result_ready", {
      ...ids,
      turns_used: run.turns_used,
    });
  if (run.state === "completed")
    await deps.emitTaskRunEvent(tx, run.tenant_id, "task_run.completed", {
      ...ids,
      turns_used: run.turns_used,
      duration_ms: durationMs(run, at),
    });
  if (run.state === "failed")
    await deps.emitTaskRunEvent(tx, run.tenant_id, "task_run.failed", {
      ...ids,
      failure_code: run.failure_code === null ? null : normalizeFailureCode(run.failure_code),
    });
}

const SETTLED_STATES: ReadonlySet<string> = new Set([
  "result_ready",
  "completed",
  "failed",
  "aborted",
]);

export async function writeRun(
  tx: Executor,
  deps: TaskServiceDeps,
  prior: TaskRunRow,
  set: Partial<typeof taskRuns.$inferInsert>,
  options: WriteRunOptions,
): Promise<TaskRunRow> {
  const [row] = await tx
    .update(taskRuns)
    .set({ ...set, updated_at: options.at })
    .where(and(eq(taskRuns.tenant_id, prior.tenant_id), eq(taskRuns.id, prior.id)))
    .returning();
  assertInsertRow(row, "task_runs");
  const recorded = now();
  for (const [index, entry] of (options.audits ?? []).entries())
    await auditTaskRun(tx, prior, row, entry, {
      at: options.at,
      source: options.source,
      ts: new Date(recorded + index),
    });
  if (options.announce !== false) await announceTaskRun(tx, row);
  if (row.state === prior.state) return row;
  const outcome = TERMINAL_OUTCOMES[row.state as keyof typeof TERMINAL_OUTCOMES];
  if (outcome && row.grant_id)
    await deps.revokeTaskGrantsForTaskLocked(
      tx,
      { tenant_id: row.tenant_id, task_id: row.task_id },
      { type: "system" },
      "grant_exhausted",
    );
  await emitStateEvent(tx, deps, row, options.at);
  const conversation_id = row.conversation_id;
  if (SETTLED_STATES.has(row.state) && conversation_id)
    options.effects.after.push((db) =>
      deps.cancelRunQuestions(db, {
        tenant_id: row.tenant_id,
        task_id: row.task_id,
        conversation_id,
        state: row.state as TaskRunSettledState,
      }),
    );
  if (outcome)
    options.effects.after.push(() =>
      deps.recordTaskRunOutcome({
        tenant_id: row.tenant_id,
        outcome,
        trigger: row.trigger,
        duration_ms: durationMs(row, options.at),
      }),
    );
  return row;
}

export function runEndedAtItsLimit(
  failure_code: "turn_limit_reached" | "deadline_exceeded",
  at: Date,
): { set: Partial<typeof taskRuns.$inferInsert>; audit: TaskRunAudit } {
  return {
    set: {
      state: "failed",
      failure_code,
      waiting_reason: null,
      next_check_at: null,
      sleep_reason: null,
      ended_at: at,
    },
    audit: { action: AuditAction.TASK_RUN_FAILED, actor: SYSTEM_ACTOR, result: "error" },
  };
}

export async function lockRun(
  tx: Executor,
  scope: TaskScope,
  task_run_id: string,
): Promise<{ run: TaskRunRow; task: TaskRow }> {
  const [found] = await tx
    .select({ task_id: taskRuns.task_id })
    .from(taskRuns)
    .innerJoin(tasks, and(eq(tasks.tenant_id, taskRuns.tenant_id), eq(tasks.id, taskRuns.task_id)))
    .where(
      and(
        eq(taskRuns.tenant_id, scope.tenant_id),
        eq(taskRuns.id, task_run_id),
        taskVisibility(scope),
      ),
    )
    .limit(1);
  if (!found) throw new NotFoundError("task run");
  const task = await lockTask(tx, scope, found.task_id, { include_archived: true });
  const [run] = await tx
    .select()
    .from(taskRuns)
    .where(and(eq(taskRuns.tenant_id, scope.tenant_id), eq(taskRuns.id, task_run_id)))
    .for("update")
    .limit(1);
  if (!run) throw new NotFoundError("task run");
  return { run, task };
}

export async function findOpenRun(
  tx: Executor,
  tenant_id: string,
  task_id: string,
  lock = false,
): Promise<TaskRunRow | null> {
  const query = tx
    .select()
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.tenant_id, tenant_id),
        eq(taskRuns.task_id, task_id),
        inArray(taskRuns.state, [...TASK_RUN_OPEN_STATES]),
      ),
    )
    .limit(1);
  const [row] = lock ? await query.for("update") : await query;
  return row ?? null;
}

export async function abortRunRow(
  tx: Executor,
  deps: TaskServiceDeps,
  run: TaskRunRow,
  options: {
    actor: TaskActor;
    at: Date;
    effects: TaskEffects;
    reason?: TaskRunEndReason;
    source?: TaskRunSource | undefined;
    principal?: ResolvedPrincipal | null;
  },
): Promise<TaskRunRow> {
  const aborted = await writeRun(
    tx,
    deps,
    run,
    {
      state: "aborted",
      waiting_reason: null,
      next_check_at: null,
      sleep_reason: null,
      failure_code: options.reason ?? null,
      ended_at: options.at,
    },
    {
      at: options.at,
      effects: options.effects,
      source: options.source,
      audits: [
        ...(options.actor.actor_type === "system"
          ? []
          : [{ action: AuditAction.TASK_RUN_ABORT_REQUESTED, actor: options.actor }]),
        { action: AuditAction.TASK_RUN_ABORTED, actor: SYSTEM_ACTOR },
      ],
    },
  );
  const conversation_id = aborted.conversation_id;
  if (conversation_id)
    options.effects.after.push((db) =>
      deps.cancelRunConversation(db, {
        tenant_id: aborted.tenant_id,
        conversation_id,
        actor: options.actor,
        principal: options.principal ?? null,
      }),
    );
  return aborted;
}

export async function closeOpenRun(
  tx: Executor,
  deps: TaskServiceDeps,
  p: {
    tenant_id: string;
    task_id: string;
    actor: TaskActor;
    at: Date;
    effects: TaskEffects;
    reason: TaskRunEndReason;
  },
): Promise<TaskRunRow | null> {
  const open = await findOpenRun(tx, p.tenant_id, p.task_id, true);
  return open ? await abortRunRow(tx, deps, open, p) : null;
}
