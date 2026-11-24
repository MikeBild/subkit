import { AuditAction, auditAwait } from "../../audit/index.ts";
import { assertInsertRow, type Db, type Executor, taskRuns } from "../../db/index.ts";
import { can } from "../../rbac/index.ts";
import { getSkillBySlug } from "../../skills/index.ts";
import { decideTaskAdmission, taskTriggerNeedsGrant } from "../core/admission.ts";
import { taskRunSkillSlugs, taskRunStart, taskRunStarterValid } from "../core/run-start.ts";
import { taskRunIsOpen } from "../core/run-state.ts";
import { nextTaskStart, taskScheduleClock, taskTriggerFor } from "../core/schedule.ts";
import {
  conversationPlaybookRevision,
  findOpenGrant,
  markTaskClaimed,
  openRunConversationIds,
  unpreparedRunIds,
} from "../persistence/run-start-rows.ts";
import { withTaskRunTrace } from "../trace.ts";
import type { TaskAdmissionReason, TaskRun, TaskRunTrigger } from "../types.ts";
import { recordTaskAdmissionChange } from "./admission.ts";
import {
  abortRunRow,
  announceTaskRun,
  auditTaskRun,
  findOpenRun,
  lockRun,
  type TaskRunSource,
  writeRun,
} from "./run-rows.ts";
import { taskRunPrincipal } from "./runs.ts";
import {
  actorOf,
  grantFacts,
  lockTask,
  rowToTaskRun,
  SYSTEM_ACTOR,
  SYSTEM_SCOPE,
  type TaskEffects,
  type TaskOwnerFacts,
  type TaskPrincipal,
  type TaskRow,
  type TaskRunRow,
  type TaskServiceDeps,
  taskRunStarterInvalid,
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

function traceId(): string {
  return crypto.randomUUID().replaceAll("-", "");
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
  const grant = needsGrant ? await findOpenGrant(tx, task) : undefined;
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
  const traced = <T>(fn: () => T): T =>
    scheduled_now ? withTaskRunTrace({ ...run, conversation_id: null }, fn) : fn();
  await traced(() =>
    auditTaskRun(
      tx,
      run,
      run,
      {
        action: AuditAction.TASK_RUN_STARTED,
        actor: actorOf(p.started_by),
        environment: task.environment,
      },
      { at, source: p.source },
    ),
  );
  if (scheduled_now) {
    await markTaskClaimed(tx, task, at);
    await recordTaskAdmissionChange(tx, { ...change, reason: null, source: p.source });
    await traced(() =>
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

async function activeSkills(db: Db, task: TaskRow): Promise<string[]> {
  const active: string[] = [];
  for (const slug of taskRunSkillSlugs(task.bindings.skill_slugs)) {
    const skill = await getSkillBySlug(task.tenant_id, slug, db);
    if (skill?.status === "active") active.push(slug);
  }
  return active;
}

async function prepareRunConversation(
  db: Db,
  deps: TaskServiceDeps,
  admitted: Admitted,
): Promise<string> {
  const { task, run, owner } = admitted;
  return await deps.openRunConversation(db, {
    tenant_id: task.tenant_id,
    owner_id: task.owner_id,
    principal: taskRunPrincipal(task, owner, run),
    title: task.name,
    task_run: {
      task_id: task.id,
      task_run_id: run.id,
      environment: task.environment,
      workflow_ids: [...task.bindings.workflow_ids],
      connector_ids: [...task.bindings.connector_ids],
      web_search: task.bindings.web_search,
    },
    plan_template: task.plan,
    goal: task.goal,
    started_at: run.created_at.toISOString(),
    skills: await activeSkills(db, task),
  });
}

async function failStart(
  db: Db,
  deps: TaskServiceDeps,
  ref: { tenant_id: string; task_run_id: string },
  p: { source: TaskRunSource | undefined; stalled_before: Date | null },
): Promise<TaskRunRow | null> {
  return await withTaskEffects(db, async (tx, effects) => {
    const { run } = await lockRun(
      tx,
      { tenant_id: ref.tenant_id, principal: SYSTEM_SCOPE },
      ref.task_run_id,
    );
    if (!taskRunIsOpen(run.state)) return null;
    if (
      p.stalled_before &&
      taskRunStart(
        { ...run, playbook_revision: await conversationPlaybookRevision(tx, run) },
        p.stalled_before,
      ) !== "stalled"
    )
      return null;
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
        source: p.source,
        audits: [{ action: AuditAction.TASK_RUN_FAILED, actor: SYSTEM_ACTOR, result: "error" }],
      },
    );
    for (const conversation_id of await openRunConversationIds(tx, failed))
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

async function openTaskRun(
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
  try {
    const conversation_id = await prepareRunConversation(db, deps, outcome);
    const { run, attached } = await attachRunConversation(
      db,
      deps,
      outcome.run,
      conversation_id,
      p.source,
    );
    return attached
      ? { admitted: true, run: rowToTaskRun(run) }
      : { admitted: false, reason: "run_ended", run: rowToTaskRun(run) };
  } catch (error) {
    await failStart(
      db,
      deps,
      { tenant_id: p.tenant_id, task_run_id: outcome.run.id },
      { source: p.source, stalled_before: null },
    );
    throw error;
  }
}

export async function startTaskRun(
  p: StartTaskRunParams,
  db: Db,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<StartTaskRunResult> {
  const deps = taskServiceDeps(overrides);
  if (!taskRunStarterValid(p.trigger, p.started_by !== SYSTEM_SCOPE)) throw taskRunStarterInvalid();
  const started = await openTaskRun(p, db, deps, null);
  if (started.admitted || "run" in started) return started;
  if (started.reason === "not_due") throw new Error("a manual start has no schedule to wait for");
  return { admitted: false, reason: started.reason };
}

export async function startScheduledTaskRun(
  p: { tenant_id: string; task_id: string; trigger: "once" | "cron"; now: Date },
  db: Db,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<ScheduledTaskStart> {
  return await openTaskRun(
    { ...p, started_by: SYSTEM_SCOPE, source: "scheduler" },
    db,
    taskServiceDeps(overrides),
    p.now,
  );
}

export async function failStalledStarts(
  tenant_id: string,
  older_than: Date,
  db: Db,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<string[]> {
  const deps = taskServiceDeps(overrides);
  const stalled = await unpreparedRunIds(db, tenant_id, older_than);
  const failed: string[] = [];
  for (const id of stalled) {
    const row = await failStart(
      db,
      deps,
      { tenant_id, task_run_id: id },
      { source: "scheduler", stalled_before: older_than },
    );
    if (row) failed.push(row.id);
  }
  return failed;
}
