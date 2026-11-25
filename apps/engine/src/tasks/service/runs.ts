import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { PlaybookPlanSchema, readPlaybook } from "../../conversations/public/authoring.ts";
import type { Db, Executor } from "../../db/client.ts";
import { conversations } from "../../db/schema/index.ts";
import { ConflictError, ForbiddenError } from "../../http/errors.ts";
import { type TaskPlaybookFacts, taskPlaybookFacts } from "../core/plan-instance.ts";
import {
  decideTaskRunResume,
  decideTaskRunState,
  TASK_TURN_STOPPED,
  type TaskRunDecision,
  type TaskRunObservation,
  taskRunIsOpen,
} from "../core/run-state.ts";
import type { TaskRun } from "../types.ts";
import {
  abortRunRow,
  findOpenRun,
  lockRun,
  runEndedAtItsLimit,
  type TaskRunAudit,
  type TaskRunEndReason,
  type TaskRunSource,
  writeRun,
} from "./run-rows.ts";
import {
  actorOf,
  rowToTaskRun,
  SYSTEM_ACTOR,
  SYSTEM_SCOPE,
  type TaskActor,
  type TaskEffects,
  type TaskLocale,
  type TaskOwnerFacts,
  type TaskPrincipal,
  type TaskRow,
  type TaskRunRow,
  type TaskServiceDeps,
  taskServiceDeps,
  withTaskEffects,
} from "./shared.ts";

export function taskRunPrincipal(
  task: Pick<TaskRow, "tenant_id" | "owner_id" | "id" | "bindings">,
  owner: TaskOwnerFacts,
  run: { id: string; grant_id: string | null } | null,
): ResolvedPrincipal {
  return {
    provider: "task",
    kind: "user",
    id: task.owner_id,
    tenant_id: task.tenant_id,
    roles: owner.roles,
    ...(owner.email ? { email: owner.email } : {}),
    ...(run
      ? {
          allowed_workflows: [...task.bindings.workflow_ids],
          allowed_connectors: [...task.bindings.connector_ids],
          auth_source: {
            kind: "task_run" as const,
            task_id: task.id,
            task_run_id: run.id,
            grant_id: run.grant_id,
          },
        }
      : {}),
  };
}

export async function completeTaskRun(
  p: { tenant_id: string; principal: ResolvedPrincipal; task_run_id: string },
  db: Db,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<TaskRun> {
  const deps = taskServiceDeps(overrides);
  if (p.principal?.kind !== "user")
    throw new ForbiddenError("task_run_confirmation_needs_a_person");
  const actor = actorOf(p.principal);
  const result = await withTaskEffects(db, async (tx, effects) => {
    const { run, task } = await lockRun(tx, p, p.task_run_id);
    if (run.state === "completed") return { run, tampered: false };
    if (run.state !== "result_ready")
      throw new ConflictError("Only a run with a result can be confirmed.", { state: run.state });
    const at = deps.now();
    const playbook = run.conversation_id
      ? await readTaskRunPlaybook(
          {
            tenant_id: p.tenant_id,
            conversation_id: run.conversation_id,
            principal: p.principal,
            goal: task.goal,
          },
          tx,
        )
      : null;
    if (!playbook?.intact)
      return {
        tampered: true,
        run: await writeRun(
          tx,
          deps,
          run,
          { state: "failed", failure_code: "playbook_tampered", ended_at: at },
          {
            at,
            effects,
            audits: [{ action: AuditAction.TASK_RUN_FAILED, actor: SYSTEM_ACTOR, result: "error" }],
          },
        ),
      };
    return {
      tampered: false,
      run: await writeRun(
        tx,
        deps,
        run,
        { state: "completed", completed_at: at, completed_by: p.principal.id, ended_at: at },
        { at, effects, audits: [{ action: AuditAction.TASK_RUN_COMPLETED, actor }] },
      ),
    };
  });
  if (result.tampered)
    throw new ConflictError("The plan of this run was changed; the result cannot be confirmed.", {
      code: "playbook_tampered",
      state: result.run.state,
    });
  return rowToTaskRun(result.run);
}

async function conversationOpen(
  tx: Executor,
  tenant_id: string,
  conversation_id: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ status: conversations.status })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, conversation_id)))
    .limit(1);
  return row !== undefined && row.status !== "abandoned";
}

export async function abortTaskRun(
  p: {
    tenant_id: string;
    principal: TaskPrincipal;
    task_run_id: string;
    system_reason?: TaskRunEndReason;
  },
  db: Db,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<TaskRun> {
  const deps = taskServiceDeps(overrides);
  const actor = actorOf(p.principal);
  const principal = p.principal === SYSTEM_SCOPE ? null : p.principal;
  const reason = p.principal === SYSTEM_SCOPE ? p.system_reason : undefined;
  return await withTaskEffects(db, async (tx, effects) => {
    const { run } = await lockRun(tx, p, p.task_run_id);
    if (run.state === "aborted") {
      const conversation_id = run.conversation_id;
      if (conversation_id && (await conversationOpen(tx, p.tenant_id, conversation_id)))
        effects.after.push((plain) =>
          deps.cancelRunConversation(plain, {
            tenant_id: p.tenant_id,
            conversation_id,
            actor,
            principal,
          }),
        );
      return rowToTaskRun(run);
    }
    if (!taskRunIsOpen(run.state))
      throw new ConflictError("This run has already ended.", { state: run.state });
    return rowToTaskRun(
      await abortRunRow(tx, deps, run, {
        actor,
        at: deps.now(),
        effects,
        principal,
        ...(reason ? { reason } : {}),
      }),
    );
  });
}

function transitionAudit(prior: TaskRunRow, decision: TaskRunDecision, person: TaskActor | null) {
  const system = { actor: SYSTEM_ACTOR };
  if (decision.state === prior.state) return [];
  const audits: Partial<Record<TaskRunDecision["state"], TaskRunAudit>> = {
    running: { action: AuditAction.TASK_RUN_RESUMED, ...system },
    waiting: { action: AuditAction.TASK_RUN_WAITING, ...system },
    sleeping: { action: AuditAction.TASK_RUN_WAITING, ...system },
    result_ready: { action: AuditAction.TASK_RUN_RESULT_READY, ...system },
    completed: { action: AuditAction.TASK_RUN_COMPLETED, actor: person ?? SYSTEM_ACTOR },
    failed: { action: AuditAction.TASK_RUN_FAILED, ...system, result: "error" },
  };
  const entry = audits[decision.state];
  return entry ? [entry] : [];
}

function taskHoldsRuns(task: TaskRow): boolean {
  return task.paused_at !== null || task.lifecycle !== "active";
}

async function endOutdatedRun(
  tx: Executor,
  deps: TaskServiceDeps,
  run: TaskRunRow,
  task: TaskRow,
  effects: TaskEffects,
  source: TaskRunSource | undefined,
): Promise<TaskRunRow | null> {
  if (!taskRunIsOpen(run.state)) return null;
  const reason =
    task.lifecycle !== "active"
      ? "task_archived"
      : run.fingerprint !== task.fingerprint
        ? "task_changed"
        : null;
  if (!reason) return null;
  return await abortRunRow(tx, deps, run, {
    actor: SYSTEM_ACTOR,
    at: deps.now(),
    effects,
    reason,
    source,
  });
}

export interface RecordRunObservationParams {
  tenant_id: string;
  task_run_id: string;
  observation: TaskRunObservation;
  source?: TaskRunSource;
}

export interface RunObservationResult {
  run: TaskRun;
  changed: boolean;
  enqueue: boolean;
}

async function reopenRejectedResult(
  tx: Executor,
  deps: TaskServiceDeps,
  run: TaskRunRow,
  task: TaskRow,
  effects: TaskEffects,
  p: {
    source?: TaskRunSource | undefined;
    turn_id: string | null;
    turn_seq?: number | null;
    actor: TaskActor;
    reason_code?: "result_rejected";
  },
): Promise<RunObservationResult> {
  const blocked =
    taskHoldsRuns(task) ||
    run.fingerprint !== task.fingerprint ||
    (await findOpenRun(tx, run.tenant_id, run.task_id)) !== null;
  if (blocked) return { run: rowToTaskRun(run), changed: false, enqueue: false };
  const at = deps.now();
  const decision = decideTaskRunResume(
    { ...run, state: "waiting" },
    { max_turns: task.max_turns },
    at,
  );
  const ended = decision.resume ? null : runEndedAtItsLimit(decision.failure_code, at);
  const reopened = await writeRun(
    tx,
    deps,
    run,
    {
      state: "running",
      waiting_reason: null,
      no_progress_count: 0,
      result_ready_at: null,
      ended_at: null,
      last_seen_turn_id: p.turn_id ?? run.last_seen_turn_id,
      last_seen_turn_seq: Math.max(run.last_seen_turn_seq, p.turn_seq ?? 0),
      rejected_playbook_revision: run.last_playbook_revision,
      turn_job_failures: 0,
      ...ended?.set,
    },
    {
      at,
      effects,
      source: p.source,
      audits: [
        {
          ...(ended ? ended.audit : { action: AuditAction.TASK_RUN_RESUMED }),
          actor: p.actor,
          ...(p.reason_code ? { reason_code: p.reason_code } : {}),
        },
      ],
    },
  );
  return { run: rowToTaskRun(reopened), changed: true, enqueue: decision.resume };
}

export async function recordRunObservation(
  p: RecordRunObservationParams,
  db: Db,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<RunObservationResult> {
  const deps = taskServiceDeps(overrides);
  const observation = p.observation;
  return await withTaskEffects(db, async (tx, effects) => {
    const { run, task } = await lockRun(
      tx,
      { tenant_id: p.tenant_id, principal: SYSTEM_SCOPE },
      p.task_run_id,
    );
    const unchanged = { run: rowToTaskRun(run), changed: false, enqueue: false };
    const outdated = await endOutdatedRun(tx, deps, run, task, effects, p.source);
    if (outdated) return { run: rowToTaskRun(outdated), changed: true, enqueue: false };
    const settled = run.state === "result_ready";
    if (!taskRunIsOpen(run.state) && !settled) return unchanged;
    if (observation.turn_id !== null && observation.turn_id === run.last_seen_turn_id)
      return unchanged;
    const at = deps.now();
    const cancelled =
      run.state === "sleeping" &&
      run.sleep_reason === "paused" &&
      (observation.turn_failure !== null || observation.turn_interrupted);
    const decided = decideTaskRunState(
      cancelled
        ? { ...observation, turn_id: null, turn_failure: null, turn_interrupted: false }
        : observation,
      run,
      { max_turns: task.max_turns },
      at,
    );
    const waitsAfterStop = run.state === "waiting" && run.waiting_reason === "turn_stopped";
    if (waitsAfterStop && observation.turn_id !== null && !decided.turn_seen) return unchanged;
    if (settled && decided.state !== "completed") {
      if (observation.result_rejected)
        return await reopenRejectedResult(tx, deps, run, task, effects, {
          source: p.source,
          turn_id: observation.turn_id,
          turn_seq: observation.turn_seq,
          actor: SYSTEM_ACTOR,
          reason_code: "result_rejected",
        });
      if (!decided.turn_seen || observation.turn_id === null) return unchanged;
      const seen = await writeRun(
        tx,
        deps,
        run,
        { last_seen_turn_id: observation.turn_id, last_seen_turn_seq: decided.last_seen_turn_seq },
        { at: run.updated_at, effects, announce: false },
      );
      return { run: rowToTaskRun(seen), changed: false, enqueue: false };
    }
    const held = decided.state === "running" && taskHoldsRuns(task);
    const stopped =
      run.state === "waiting" &&
      run.waiting_reason === TASK_TURN_STOPPED &&
      observation.turn_driver === "task" &&
      (decided.state === "running" || decided.state === "sleeping");
    const decision: TaskRunDecision = stopped
      ? {
          ...decided,
          state: "waiting",
          waiting_reason: TASK_TURN_STOPPED,
          next_check_at: null,
          sleep_reason: null,
          enqueue: false,
        }
      : held
        ? { ...decided, state: "sleeping", sleep_reason: "paused", enqueue: false }
        : decided;
    const changed = decision.state !== run.state;
    const open = taskRunIsOpen(decision.state);
    const person: TaskActor | null =
      decision.state === "completed"
        ? { actor_type: "user", actor_id: observation.result_confirmed_by }
        : null;
    const updated = await writeRun(
      tx,
      deps,
      run,
      {
        state: decision.state,
        waiting_reason: decision.waiting_reason,
        next_check_at: decision.next_check_at,
        sleep_reason: decision.sleep_reason,
        failure_code: decision.failure_code,
        turns_used: decision.turns_used,
        no_progress_count: decision.no_progress_count,
        last_playbook_revision: decision.last_playbook_revision,
        progress_marks: decision.progress_marks,
        last_seen_turn_id: decided.turn_seen
          ? (observation.turn_id ?? run.last_seen_turn_id)
          : run.last_seen_turn_id,
        last_seen_turn_seq: decision.last_seen_turn_seq,
        ...(decided.turn_seen || decision.waiting_reason === "turn_stopped"
          ? { turn_job_failures: 0 }
          : {}),
        ...(run.rejected_playbook_revision !== null &&
        decision.last_playbook_revision !== run.rejected_playbook_revision
          ? { rejected_playbook_revision: null }
          : {}),
        ...(decision.state === "result_ready" ? { result_ready_at: at } : {}),
        ...(decision.state === "completed"
          ? { completed_at: at, completed_by: person?.actor_id ?? null }
          : {}),
        ...(open ? {} : { ended_at: run.ended_at ?? at }),
      },
      {
        at,
        effects,
        source: p.source,
        audits: transitionAudit(run, decision, person),
        announce:
          changed ||
          decision.waiting_reason !== run.waiting_reason ||
          decision.next_check_at?.getTime() !== run.next_check_at?.getTime(),
      },
    );
    const conversation_id = updated.conversation_id;
    if (decision.sleep_reason === "check_requested" && conversation_id)
      effects.after.push((plain) =>
        deps.clearRunCheck(plain, { tenant_id: p.tenant_id, conversation_id }),
      );
    return { run: rowToTaskRun(updated), changed, enqueue: decision.enqueue };
  });
}

export async function rejectTaskRunResult(
  p: {
    tenant_id: string;
    principal: ResolvedPrincipal;
    task_run_id: string;
    source?: TaskRunSource;
  },
  db: Db,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<{ run: TaskRun; enqueue: boolean }> {
  const deps = taskServiceDeps(overrides);
  if (p.principal?.kind !== "user")
    throw new ForbiddenError("task_run_confirmation_needs_a_person");
  const actor = actorOf(p.principal);
  return await withTaskEffects(db, async (tx, effects) => {
    const { run, task } = await lockRun(tx, p, p.task_run_id);
    if (run.state !== "result_ready")
      throw new ConflictError("Only a run with a result can be rejected.", { state: run.state });
    const reopened = await reopenRejectedResult(tx, deps, run, task, effects, {
      source: p.source,
      turn_id: null,
      actor,
      reason_code: "result_rejected",
    });
    if (!reopened.changed)
      throw new ConflictError(
        "The result cannot be reopened: the task changed, is paused or archived, or has another run in progress.",
        { code: "task_run_reopen_blocked", state: run.state },
      );
    return { run: reopened.run, enqueue: reopened.enqueue };
  });
}

export async function resumeTaskRun(
  p: { tenant_id: string; task_run_id: string; source?: TaskRunSource },
  db: Db,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<{ run: TaskRun; resumed: boolean }> {
  const deps = taskServiceDeps(overrides);
  return await withTaskEffects(db, async (tx, effects) => {
    const { run, task } = await lockRun(
      tx,
      { tenant_id: p.tenant_id, principal: SYSTEM_SCOPE },
      p.task_run_id,
    );
    const outdated = await endOutdatedRun(tx, deps, run, task, effects, p.source);
    if (outdated) return { run: rowToTaskRun(outdated), resumed: false };
    if ((run.state !== "waiting" && run.state !== "sleeping") || taskHoldsRuns(task))
      return { run: rowToTaskRun(run), resumed: false };
    const at = deps.now();
    const decision = decideTaskRunResume(run, { max_turns: task.max_turns }, at);
    const ended = decision.resume ? null : runEndedAtItsLimit(decision.failure_code, at);
    const updated = await writeRun(
      tx,
      deps,
      run,
      decision.resume
        ? {
            state: "running",
            waiting_reason: null,
            next_check_at: null,
            sleep_reason: null,
            no_progress_count: decision.no_progress_count,
          }
        : runEndedAtItsLimit(decision.failure_code, at).set,
      {
        at,
        effects,
        source: p.source,
        audits: [
          ended ? ended.audit : { action: AuditAction.TASK_RUN_RESUMED, actor: SYSTEM_ACTOR },
        ],
      },
    );
    return { run: rowToTaskRun(updated), resumed: decision.resume };
  });
}

export async function readTaskRunPlaybook(
  p: {
    tenant_id: string;
    conversation_id: string;
    principal: ResolvedPrincipal;
    goal: string;
    locale?: TaskLocale;
  },
  db: Executor,
): Promise<TaskPlaybookFacts | null> {
  const view = await readPlaybook(db, {
    tenant_id: p.tenant_id,
    conversation_id: p.conversation_id,
    principal: p.principal,
    ...(p.locale ? { locale: p.locale } : {}),
  });
  if (!view) return null;
  const [row] = await db
    .select({ playbook: conversations.playbook })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, p.tenant_id), eq(conversations.id, p.conversation_id)))
    .limit(1);
  const plan = PlaybookPlanSchema.safeParse((row?.playbook as { plan?: unknown } | null)?.plan);
  return plan.success ? taskPlaybookFacts(view, plan.data, p.goal) : null;
}
