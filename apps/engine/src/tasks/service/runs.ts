import { and, eq, isNull, lt } from "drizzle-orm";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  createConversation,
  PlaybookPlanSchema,
  readPlaybook,
  setConversationLoadedSkills,
  type TaskRunMarker,
  updatePlaybook,
} from "../../conversations/public/authoring.ts";
import { assertInsertRow } from "../../db/assert-insert.ts";
import type { Db, Executor } from "../../db/client.ts";
import { conversations, taskGrants, taskRuns, tasks } from "../../db/schema/index.ts";
import { BadRequestError, ConflictError, ForbiddenError } from "../../http/errors.ts";
import { can } from "../../rbac/evaluator.ts";
import { getSkillBySlug } from "../../skills/service.ts";
import { decideTaskAdmission, taskTriggerNeedsGrant } from "../core/admission.ts";
import {
  instantiateTaskPlan,
  type TaskPlaybookFacts,
  taskPlaybookFacts,
} from "../core/plan-instance.ts";
import {
  decideTaskRunResume,
  decideTaskRunState,
  type TaskRunDecision,
  type TaskRunObservation,
  taskRunIsOpen,
} from "../core/run-state.ts";
import { nextTaskStart, taskScheduleClock, taskTriggerFor } from "../core/schedule.ts";
import { withTaskRunAuditTrace } from "../trace.ts";
import type { TaskAdmissionReason, TaskRun, TaskRunTrigger } from "../types.ts";
import { recordTaskAdmissionChange } from "./admission.ts";
import {
  abortRunRow,
  announceTaskRun,
  auditTaskRun,
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
  grantFacts,
  lockTask,
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

export type StartTaskRunResult =
  | { admitted: true; run: TaskRun }
  | { admitted: false; reason: TaskAdmissionReason }
  | { admitted: false; reason: "run_ended"; run: TaskRun };

export interface StartTaskRunParams {
  tenant_id: string;
  task_id: string;
  trigger: TaskRunTrigger;
  started_by: TaskPrincipal;
  source?: TaskRunSource;
}

export type ScheduledTaskStart =
  | { admitted: true; run: TaskRun }
  | { admitted: false; reason: TaskAdmissionReason | "not_due"; changed: boolean }
  | { admitted: false; reason: "run_ended"; run: TaskRun };

export const TASK_RUN_SEED_SKILL = "working-on-a-task";

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

function traceId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}

function assertStarter(p: StartTaskRunParams): void {
  const person = p.started_by !== SYSTEM_SCOPE;
  if (person !== (p.trigger === "manual"))
    throw new BadRequestError("A person starts manual runs; scheduled runs start without one.", {
      code: "task_run_starter_invalid",
    });
}

type Admitted = { task: TaskRow; run: TaskRunRow; owner: TaskOwnerFacts };
type Refused = { refused: TaskAdmissionReason | "not_due"; changed: boolean };

function owedStart(task: TaskRow, trigger: TaskRunTrigger, now: Date): Date | null {
  const schedule = {
    schedule_cron: task.schedule_cron,
    schedule_timezone: task.schedule_timezone,
    schedule_run_at: task.schedule_run_at?.toISOString() ?? null,
  };
  if (taskTriggerFor(schedule) !== trigger) return null;
  const next = nextTaskStart(schedule, taskScheduleClock(task));
  return next !== null && next <= now ? next : null;
}

async function admitAndInsert(
  tx: Executor,
  deps: TaskServiceDeps,
  p: StartTaskRunParams,
  effects: TaskEffects,
  scheduled_now: Date | null = null,
): Promise<Admitted | Refused> {
  const task = await lockTask(tx, { tenant_id: p.tenant_id, principal: p.started_by }, p.task_id);
  const at = deps.now();
  const owed = scheduled_now ? owedStart(task, p.trigger, scheduled_now) : null;
  if (scheduled_now && !owed) return { refused: "not_due", changed: false };
  const change = { tenant_id: p.tenant_id, task_id: task.id, trigger: p.trigger, at };
  const refuse = async (reason: TaskAdmissionReason): Promise<Refused> => ({
    refused: reason,
    changed: scheduled_now
      ? await recordTaskAdmissionChange(tx, { ...change, reason, since: owed, source: p.source })
      : true,
  });
  const owner = await deps.loadOwner(tx, p.tenant_id, task.owner_id);
  const permitted =
    owner.active &&
    (
      await can(tx, {
        tenant_id: p.tenant_id,
        principal: taskRunPrincipal(task, owner, null),
        permission: "task:run",
      })
    ).allow;
  const needsGrant = taskTriggerNeedsGrant(p.trigger);
  const [grant] = needsGrant
    ? await tx
        .select()
        .from(taskGrants)
        .where(
          and(
            eq(taskGrants.tenant_id, p.tenant_id),
            eq(taskGrants.task_id, task.id),
            eq(taskGrants.environment, task.environment),
            isNull(taskGrants.revoked_at),
          ),
        )
        .limit(1)
    : [];
  const admission = decideTaskAdmission(
    {
      task: { paused: task.paused_at !== null, fingerprint: task.fingerprint },
      owner: { active: owner.active, permitted },
      ai_access: await deps.aiAccessConfigured(tx, p.tenant_id),
      previous_run_active: (await findOpenRun(tx, p.tenant_id, task.id)) !== null,
      trigger: p.trigger,
      grant: grant ? grantFacts(grant) : null,
    },
    at,
  );
  if (!admission.admit) return await refuse(admission.reason);
  let grant_id: string | null = null;
  if (grant) {
    const reservation = await deps.reserveTaskGrantRun(tx, {
      tenant_id: p.tenant_id,
      grant_id: grant.id,
    });
    if (!reservation.reserved) return await refuse(reservation.reason);
    grant_id = reservation.grant.id;
  }
  const [run] = await tx
    .insert(taskRuns)
    .values({
      tenant_id: p.tenant_id,
      task_id: task.id,
      task_revision: task.revision,
      fingerprint: task.fingerprint,
      trigger: p.trigger,
      started_by: p.started_by === SYSTEM_SCOPE ? null : p.started_by.id,
      grant_id,
      state: "running",
      deadline_at: new Date(at.getTime() + task.run_deadline_minutes * 60_000),
      trace_id: traceId(),
      created_at: at,
      updated_at: at,
    })
    .returning();
  assertInsertRow(run, "task_runs");
  await auditTaskRun(
    tx,
    run,
    run,
    {
      action: AuditAction.TASK_RUN_STARTED,
      actor: actorOf(p.started_by),
      environment: task.environment,
    },
    { at, source: p.source },
  );
  if (scheduled_now) {
    await tx
      .update(tasks)
      .set({ last_claimed_at: at })
      .where(and(eq(tasks.tenant_id, p.tenant_id), eq(tasks.id, task.id)));
    await recordTaskAdmissionChange(tx, { ...change, reason: null, source: p.source });
    await withTaskRunAuditTrace(run, () =>
      auditAwait(
        {
          tenant_id: p.tenant_id,
          ts: at,
          actor_type: "system",
          actor_id: null,
          action: AuditAction.TASK_SCHEDULE_CLAIMED,
          resource_type: "task",
          resource_id: task.id,
          result: "success",
          trace_id: run.trace_id,
          metadata: {
            task_id: task.id,
            task_run_id: run.id,
            trigger: p.trigger,
            request_source: p.source ?? "scheduler",
          },
        },
        tx,
      ),
    );
  }
  await announceTaskRun(tx, run);
  await deps.emitTaskRunEvent(tx, run.tenant_id, "task_run.started", {
    task_run_id: run.id,
    task_id: run.task_id,
    trigger: run.trigger,
    environment: task.environment,
  });
  effects.after.push(() =>
    deps.recordTaskRunOutcome({
      tenant_id: run.tenant_id,
      outcome: "started",
      trigger: run.trigger,
      duration_ms: 0,
    }),
  );
  return { task, run, owner };
}

async function openRunConversation(
  db: Db,
  admitted: Admitted,
  onCreated: (conversation_id: string) => Promise<boolean>,
): Promise<void> {
  const { task, run, owner } = admitted;
  const principal = taskRunPrincipal(task, owner, run);
  const marker: TaskRunMarker = {
    task_id: task.id,
    task_run_id: run.id,
    environment: task.environment,
    workflow_ids: [...task.bindings.workflow_ids],
    connector_ids: [...task.bindings.connector_ids],
    web_search: task.bindings.web_search,
  };
  const { conversation } = await createConversation(
    {
      tenant_id: task.tenant_id,
      actor_id: task.owner_id,
      principal,
      title: task.name,
      permission_mode: "auto",
      surface: "web",
      playbook_mode: "auto",
      task_run: marker,
    },
    db,
  );
  if (!(await onCreated(conversation.id))) return;
  const scope = { tenant_id: task.tenant_id, conversation_id: conversation.id };
  await updatePlaybook(
    db,
    { ...scope, principal },
    {
      expected_revision: 0,
      plan: instantiateTaskPlan(PlaybookPlanSchema.parse(task.plan), {
        goal: task.goal,
        started_at: run.created_at.toISOString(),
      }),
    },
  );
  const bound: string[] = [];
  for (const slug of new Set([TASK_RUN_SEED_SKILL, ...task.bindings.skill_slugs])) {
    const skill = await getSkillBySlug(task.tenant_id, slug, db);
    if (skill?.status === "active") bound.push(slug);
  }
  if (bound.length === 0) return;
  const [row] = await db
    .select({ loaded_skills: conversations.loaded_skills })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, task.tenant_id), eq(conversations.id, conversation.id)))
    .limit(1);
  const loaded = row?.loaded_skills ?? [];
  const known = new Set(loaded.map((entry) => entry.slug));
  await setConversationLoadedSkills(db, scope, [
    ...loaded,
    ...bound.filter((slug) => !known.has(slug)).map((slug) => ({ slug, last_turn: 0 })),
  ]);
}

async function failOpenRun(
  db: Db,
  deps: TaskServiceDeps,
  ref: { tenant_id: string; task_run_id: string },
  source: TaskRunSource | undefined,
): Promise<TaskRunRow | null> {
  return await withTaskEffects(db, async (tx, effects) => {
    const { run } = await lockRun(
      tx,
      { tenant_id: ref.tenant_id, principal: SYSTEM_SCOPE },
      ref.task_run_id,
    );
    if (!taskRunIsOpen(run.state)) return null;
    const at = deps.now();
    const failed = await writeRun(
      tx,
      deps,
      run,
      {
        state: "failed",
        failure_code: "start_failed",
        waiting_reason: null,
        next_check_at: null,
        sleep_reason: null,
        ended_at: at,
      },
      {
        at,
        effects,
        source,
        audits: [{ action: AuditAction.TASK_RUN_FAILED, actor: SYSTEM_ACTOR, result: "error" }],
      },
    );
    const conversation_id = failed.conversation_id;
    if (conversation_id)
      effects.after.push((plain) =>
        deps.cancelRunConversation(plain, {
          tenant_id: failed.tenant_id,
          conversation_id,
          actor: SYSTEM_ACTOR,
        }),
      );
    return failed;
  });
}

async function attachRunConversation(
  db: Db,
  deps: TaskServiceDeps,
  started: TaskRunRow,
  conversation_id: string,
  source: TaskRunSource | undefined,
): Promise<{ run: TaskRunRow; attached: boolean }> {
  return await withTaskEffects(db, async (tx, effects) => {
    const { run } = await lockRun(
      tx,
      { tenant_id: started.tenant_id, principal: SYSTEM_SCOPE },
      started.id,
    );
    const at = deps.now();
    if (run.state === "running" && run.conversation_id === null)
      return {
        run: await writeRun(tx, deps, run, { conversation_id }, { at, effects }),
        attached: true,
      };
    effects.after.push((plain) =>
      deps.cancelRunConversation(plain, {
        tenant_id: started.tenant_id,
        conversation_id,
        actor: SYSTEM_ACTOR,
      }),
    );
    if (!taskRunIsOpen(run.state)) return { run, attached: false };
    return {
      run: await abortRunRow(tx, deps, run, { actor: SYSTEM_ACTOR, at, effects, source }),
      attached: false,
    };
  });
}

export async function startTaskRun(
  p: StartTaskRunParams,
  db: Db,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<StartTaskRunResult> {
  const deps = taskServiceDeps(overrides);
  assertStarter(p);
  const started = await admitAndOpen(p, db, deps, null);
  if (started.admitted || "run" in started) return started;
  if (started.reason === "not_due") throw new Error("a manual start has no schedule to wait for");
  return { admitted: false, reason: started.reason };
}

export async function startScheduledTaskRun(
  p: { tenant_id: string; task_id: string; trigger: "once" | "cron"; now: Date },
  db: Db,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<ScheduledTaskStart> {
  return await admitAndOpen(
    { ...p, started_by: SYSTEM_SCOPE, source: "scheduler" },
    db,
    taskServiceDeps(overrides),
    p.now,
  );
}

async function admitAndOpen(
  p: StartTaskRunParams,
  db: Db,
  deps: TaskServiceDeps,
  scheduled_now: Date | null,
): Promise<ScheduledTaskStart> {
  const outcome = await withTaskEffects(db, (tx, effects) =>
    admitAndInsert(tx, deps, p, effects, scheduled_now),
  );
  if ("refused" in outcome) {
    if (outcome.changed && outcome.refused !== "not_due")
      deps.recordTaskAdmission({ reason: outcome.refused });
    return { admitted: false, reason: outcome.refused, changed: outcome.changed };
  }
  let run = outcome.run;
  let attached = false;
  try {
    await openRunConversation(db, outcome, async (conversation_id) => {
      const result = await attachRunConversation(db, deps, run, conversation_id, p.source);
      run = result.run;
      attached = result.attached;
      return attached;
    });
    return attached
      ? { admitted: true, run: rowToTaskRun(run) }
      : { admitted: false, reason: "run_ended", run: rowToTaskRun(run) };
  } catch (error) {
    await failOpenRun(db, deps, { tenant_id: p.tenant_id, task_run_id: run.id }, p.source);
    throw error;
  }
}

export async function failStalledStarts(
  tenant_id: string,
  older_than: Date,
  db: Db,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<string[]> {
  const deps = taskServiceDeps(overrides);
  const stalled = await db
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.tenant_id, tenant_id),
        eq(taskRuns.state, "running"),
        isNull(taskRuns.conversation_id),
        lt(taskRuns.created_at, older_than),
      ),
    )
    .orderBy(taskRuns.id);
  const failed: string[] = [];
  for (const { id } of stalled) {
    const row = await withTaskEffects(db, async (tx, effects) => {
      const { run } = await lockRun(tx, { tenant_id, principal: SYSTEM_SCOPE }, id);
      if (run.state !== "running" || run.conversation_id !== null) return null;
      const at = deps.now();
      return await writeRun(
        tx,
        deps,
        run,
        { state: "failed", failure_code: "start_failed", ended_at: at },
        {
          at,
          effects,
          source: "scheduler",
          audits: [{ action: AuditAction.TASK_RUN_FAILED, actor: SYSTEM_ACTOR, result: "error" }],
        },
      );
    });
    if (row) failed.push(row.id);
  }
  return failed;
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
    const decision: TaskRunDecision = held
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
        ...(decided.turn_seen ? { turn_job_failures: 0 } : {}),
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
