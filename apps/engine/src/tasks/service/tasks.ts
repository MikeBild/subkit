import { and, asc, desc, eq, ilike, isNull, lte, or, sql } from "drizzle-orm";
import { humanMetadataWrite } from "../../api/catalog-metadata.ts";
import { auditAwait } from "../../audit/audit.ts";
import { AuditAction } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { assertInsertRow } from "../../db/assert-insert.ts";
import { lockCatalogVocabulary } from "../../db/catalog-vocabulary.ts";
import type { Db, Executor } from "../../db/client.ts";
import { conversationMessages, conversationToolCalls, tasks } from "../../db/schema/index.ts";
import { BadRequestError, ConflictError, ForbiddenError } from "../../http/errors.ts";
import { emitResourceChange } from "../../pubsub/resource-changes.ts";
import { taskFingerprint } from "../core/fingerprint.ts";
import { goalWriterId, nextGoalEditor } from "../core/goal-editor.ts";
import { taskPlanTemplateIssue } from "../core/plan-instance.ts";
import { decideTaskRunResume } from "../core/run-state.ts";
import { taskScheduleChanged, taskScheduleIssue } from "../core/schedule.ts";
import { type TaskSource, taskSource, taskSourceMessageId } from "../core/source.ts";
import type {
  Task,
  TaskCreateInput,
  TaskLifecycle,
  TaskPausedReason,
  TaskRun,
  TaskUpdateInput,
} from "../types.ts";
import { closeOpenRun, findOpenRun, runEndedAtItsLimit, writeRun } from "./run-rows.ts";
import {
  actorOf,
  grantActor,
  lockTask,
  rowToTask,
  rowToTaskRun,
  SYSTEM_ACTOR,
  type TaskActor,
  type TaskEffects,
  type TaskLocale,
  type TaskRow,
  type TaskScope,
  type TaskServiceDeps,
  taskServiceDeps,
  taskVisibility,
  withTaskEffects,
} from "./shared.ts";

type TaskDefinition = Omit<TaskUpdateInput, "expected_revision">;

export interface ListTasksParams extends TaskScope {
  lifecycle?: TaskLifecycle;
  owner_id?: string;
  source_conversation_id?: string;
  category?: string;
  q?: string;
  sort?: "name" | "updated_at" | "created_at";
  order?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface UpdateTaskResult {
  task: Task;
  schedule_changed: boolean;
  grant_invalidated: boolean;
  aborted_run_id: string | null;
}

export interface ResumeTaskResult {
  task: Task;
  run: TaskRun | null;
  enqueue: boolean;
}

function assertPlan(input: TaskDefinition): void {
  const plan = taskPlanTemplateIssue(input.plan);
  if (plan) throw new BadRequestError("The task plan is not valid.", { code: plan });
}

function assertSchedule(input: TaskDefinition, at: Date): void {
  const schedule = taskScheduleIssue(input, at);
  if (schedule) throw new BadRequestError("The task schedule is not valid.", { code: schedule });
}

function definitionColumns(input: TaskDefinition, owner_id: string) {
  return {
    name: input.name,
    goal: input.goal,
    done_when: input.done_when,
    plan: input.plan,
    bindings: input.bindings,
    environment: input.environment,
    schedule_cron: input.schedule_cron,
    schedule_timezone: input.schedule_timezone,
    schedule_run_at: input.schedule_run_at ? new Date(input.schedule_run_at) : null,
    max_turns: input.max_turns,
    run_deadline_minutes: input.run_deadline_minutes,
    fingerprint: taskFingerprint({ ...input, owner_id }),
  };
}

function scheduleKind(row: Pick<TaskRow, "schedule_cron" | "schedule_run_at">): string {
  if (row.schedule_run_at !== null) return "once";
  return row.schedule_cron === null ? "none" : "cron";
}

function snapshot(row: Pick<TaskRow, "name" | "lifecycle">) {
  return { name: row.name, lifecycle: row.lifecycle };
}

function storedSchedule(row: TaskRow) {
  return {
    schedule_cron: row.schedule_cron,
    schedule_timezone: row.schedule_timezone,
    schedule_run_at: row.schedule_run_at?.toISOString() ?? null,
  };
}

async function announce(tx: Executor, tenant_id: string, task_id: string): Promise<void> {
  await emitResourceChange(tx, { tenant_id, type: "task.changed", ids: { task_id } });
}

export async function createTask(
  p: {
    tenant_id: string;
    principal: ResolvedPrincipal;
    input: TaskCreateInput;
    locale: TaskLocale;
    source?: TaskSource | null | undefined;
  },
  db: Executor,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<Task> {
  const deps = taskServiceDeps(overrides);
  if (p.principal?.kind !== "user" || p.principal.tenant_id !== p.tenant_id)
    throw new ForbiddenError("task_owner_must_be_a_person");
  assertPlan(p.input);
  assertSchedule(p.input, deps.now());
  return await db.transaction(async (tx) => {
    await lockCatalogVocabulary(tx, p.tenant_id);
    const [row] = await tx
      .insert(tasks)
      .values({
        tenant_id: p.tenant_id,
        owner_id: p.principal.id,
        ...definitionColumns(p.input, p.principal.id),
        goal_edited_by: goalWriterId(p.principal),
        locale: p.locale,
        ...(p.source
          ? {
              source_conversation_id: p.source.conversation_id,
              source_message_id: p.source.message_id,
            }
          : {}),
        ...humanMetadataWrite({
          description: p.input.description,
          ...(p.input.category !== undefined ? { category: p.input.category } : {}),
        }),
        description_source: "human",
        category_source: "human",
        schedule_anchor_at: deps.now(),
      })
      .returning();
    assertInsertRow(row, "tasks");
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        ...actorOf(p.principal),
        action: AuditAction.TASK_CREATED,
        resource_type: "task",
        resource_id: row.id,
        result: "success",
        after: snapshot(row),
        metadata: {
          task_id: row.id,
          revision: row.revision,
          environment: row.environment,
          owner_id: row.owner_id,
          schedule_kind: scheduleKind(row),
          ...(p.source ? { source_message_id: p.source.message_id } : {}),
        },
      },
      tx,
    );
    await announce(tx, p.tenant_id, row.id);
    return rowToTask(row);
  });
}

export async function updateTask(
  p: {
    tenant_id: string;
    principal: ResolvedPrincipal;
    task_id: string;
    input: TaskUpdateInput;
    locale?: TaskLocale | undefined;
  },
  db: Db,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<UpdateTaskResult> {
  const deps = taskServiceDeps(overrides);
  const at = deps.now();
  const actor = actorOf(p.principal);
  const { expected_revision, ...definition } = p.input;
  assertPlan(definition);
  return await withTaskEffects(db, async (tx, effects) => {
    await lockCatalogVocabulary(tx, p.tenant_id);
    const prior = await lockTask(tx, p, p.task_id);
    if (prior.revision !== expected_revision)
      throw new ConflictError("The task changed. Read it again before updating it.", {
        expected_revision,
        current_revision: prior.revision,
      });
    const schedule_changed = taskScheduleChanged(storedSchedule(prior), definition);
    if (schedule_changed) assertSchedule(definition, at);
    const columns = definitionColumns(definition, prior.owner_id);
    const grant_invalidated = columns.fingerprint !== prior.fingerprint;
    const aborted = grant_invalidated
      ? await closeOpenRun(tx, deps, {
          tenant_id: p.tenant_id,
          task_id: prior.id,
          actor,
          at,
          effects,
          reason: "task_changed",
        })
      : null;
    if (grant_invalidated)
      await deps.revokeTaskGrantsForTaskLocked(
        tx,
        { tenant_id: p.tenant_id, task_id: prior.id },
        grantActor(actor),
        "task_changed",
      );
    const [row] = await tx
      .update(tasks)
      .set({
        ...columns,
        goal_edited_by: nextGoalEditor(prior, definition, p.principal),
        ...(p.locale && p.principal.id === prior.owner_id ? { locale: p.locale } : {}),
        ...humanMetadataWrite({
          description: definition.description,
          ...(definition.category !== undefined ? { category: definition.category } : {}),
        }),
        description_source: "human",
        category_source: "human",
        ...(schedule_changed
          ? {
              last_claimed_at: null,
              admission_hold_reason: null,
              admission_hold_since: null,
              schedule_anchor_at: at,
            }
          : {}),
        revision: prior.revision + 1,
        updated_at: at,
      })
      .where(and(eq(tasks.tenant_id, p.tenant_id), eq(tasks.id, prior.id)))
      .returning();
    assertInsertRow(row, "tasks");
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        ...actor,
        action: AuditAction.TASK_UPDATED,
        resource_type: "task",
        resource_id: row.id,
        result: "success",
        before: snapshot(prior),
        after: snapshot(row),
        metadata: {
          task_id: row.id,
          revision: row.revision,
          previous_revision: prior.revision,
          environment: row.environment,
          schedule_kind: scheduleKind(row),
          grant_invalidated,
        },
      },
      tx,
    );
    await announce(tx, p.tenant_id, row.id);
    return {
      task: rowToTask(row),
      schedule_changed,
      grant_invalidated,
      aborted_run_id: aborted?.id ?? null,
    };
  });
}

export async function deleteTask(
  p: { tenant_id: string; principal: ResolvedPrincipal; task_id: string },
  db: Db,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<void> {
  const deps = taskServiceDeps(overrides);
  const actor = actorOf(p.principal);
  await withTaskEffects(db, async (tx, effects) => {
    const prior = await lockTask(tx, p, p.task_id);
    const at = deps.now();
    await closeOpenRun(tx, deps, {
      tenant_id: p.tenant_id,
      task_id: prior.id,
      actor,
      at,
      effects,
      reason: "task_archived",
    });
    await deps.revokeTaskGrantsForTaskLocked(
      tx,
      { tenant_id: p.tenant_id, task_id: prior.id },
      grantActor(actor),
      "task_archived",
    );
    const [row] = await tx
      .update(tasks)
      .set({ lifecycle: "archived", updated_at: at })
      .where(and(eq(tasks.tenant_id, p.tenant_id), eq(tasks.id, prior.id)))
      .returning();
    assertInsertRow(row, "tasks");
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        ...actor,
        action: AuditAction.TASK_DELETED,
        resource_type: "task",
        resource_id: prior.id,
        result: "success",
        before: snapshot(prior),
        after: snapshot(row),
        metadata: { task_id: prior.id, revision: prior.revision },
      },
      tx,
    );
    await announce(tx, p.tenant_id, prior.id);
  });
}

async function setPaused(
  tx: Executor,
  tenant_id: string,
  row: TaskRow,
  actor: TaskActor,
  reason: TaskPausedReason,
  at: Date,
): Promise<TaskRow> {
  const [updated] = await tx
    .update(tasks)
    .set({ paused_at: at, paused_by: actor.actor_id, paused_reason: reason, updated_at: at })
    .where(and(eq(tasks.tenant_id, tenant_id), eq(tasks.id, row.id)))
    .returning();
  assertInsertRow(updated, "tasks");
  await auditAwait(
    {
      tenant_id,
      ...actor,
      action: AuditAction.TASK_PAUSED,
      resource_type: "task",
      resource_id: row.id,
      result: "success",
      reason,
      after: snapshot(updated),
      metadata: { task_id: row.id, paused_reason: reason },
    },
    tx,
  );
  await announce(tx, tenant_id, row.id);
  return updated;
}

async function sleepOpenRun(
  tx: Executor,
  deps: TaskServiceDeps,
  task: TaskRow,
  at: Date,
  effects: TaskEffects,
): Promise<void> {
  const open = await findOpenRun(tx, task.tenant_id, task.id, true);
  if (open?.state !== "running") return;
  const slept = await writeRun(
    tx,
    deps,
    open,
    { state: "sleeping", sleep_reason: "paused", next_check_at: null },
    { at, effects, audits: [{ action: AuditAction.TASK_RUN_WAITING, actor: SYSTEM_ACTOR }] },
  );
  const conversation_id = slept.conversation_id;
  if (conversation_id)
    effects.after.push((db) =>
      deps.cancelRunTurn(db, { tenant_id: task.tenant_id, conversation_id }),
    );
}

export async function pauseTask(
  p: { tenant_id: string; principal: ResolvedPrincipal; task_id: string },
  db: Db,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<Task> {
  const deps = taskServiceDeps(overrides);
  const actor = actorOf(p.principal);
  return await withTaskEffects(db, async (tx, effects) => {
    const prior = await lockTask(tx, p, p.task_id);
    if (prior.paused_at) return rowToTask(prior);
    const at = deps.now();
    const reason = prior.owner_id === p.principal.id ? "owner_request" : "admin";
    const paused = await setPaused(tx, p.tenant_id, prior, actor, reason, at);
    await sleepOpenRun(tx, deps, paused, at, effects);
    return rowToTask(paused);
  });
}

export async function resumeTask(
  p: { tenant_id: string; principal: ResolvedPrincipal; task_id: string },
  db: Db,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<ResumeTaskResult> {
  const deps = taskServiceDeps(overrides);
  return await withTaskEffects(db, async (tx, effects) => {
    const prior = await lockTask(tx, p, p.task_id);
    const open = await findOpenRun(tx, p.tenant_id, prior.id, true);
    if (!prior.paused_at) {
      const enqueue = open?.state === "running" && open.conversation_id !== null;
      if (open && enqueue)
        effects.after.push((plain) =>
          deps.enqueueRunTurn(plain, {
            tenant_id: open.tenant_id,
            task_id: open.task_id,
            task_run_id: open.id,
          }),
        );
      return { task: rowToTask(prior), run: open ? rowToTaskRun(open) : null, enqueue };
    }
    const at = deps.now();
    const [row] = await tx
      .update(tasks)
      .set({ paused_at: null, paused_by: null, paused_reason: null, updated_at: at })
      .where(and(eq(tasks.tenant_id, p.tenant_id), eq(tasks.id, prior.id)))
      .returning();
    assertInsertRow(row, "tasks");
    await auditAwait(
      {
        tenant_id: p.tenant_id,
        ...actorOf(p.principal),
        action: AuditAction.TASK_RESUMED,
        resource_type: "task",
        resource_id: row.id,
        result: "success",
        after: snapshot(row),
        metadata: { task_id: row.id, previous_paused_reason: prior.paused_reason },
      },
      tx,
    );
    await announce(tx, p.tenant_id, row.id);
    if (open?.state !== "sleeping" || open.sleep_reason !== "paused")
      return { task: rowToTask(row), run: open ? rowToTaskRun(open) : null, enqueue: false };
    const decision = decideTaskRunResume(open, { max_turns: row.max_turns }, at);
    const ended = decision.resume ? null : runEndedAtItsLimit(decision.failure_code, at);
    const run = await writeRun(
      tx,
      deps,
      open,
      ended ? ended.set : { state: "running", sleep_reason: null, next_check_at: null },
      {
        at,
        effects,
        audits: [
          ended ? ended.audit : { action: AuditAction.TASK_RUN_RESUMED, actor: SYSTEM_ACTOR },
        ],
      },
    );
    if (decision.resume)
      effects.after.push((plain) =>
        deps.enqueueRunTurn(plain, {
          tenant_id: run.tenant_id,
          task_id: run.task_id,
          task_run_id: run.id,
        }),
      );
    return { task: rowToTask(row), run: rowToTaskRun(run), enqueue: decision.resume };
  });
}

export async function pauseTasksOfOwnerLocked(
  tx: Executor,
  tenant_id: string,
  user_id: string,
  effects: TaskEffects,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<string[]> {
  const deps = taskServiceDeps(overrides);
  const rows = await tx
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.tenant_id, tenant_id),
        eq(tasks.owner_id, user_id),
        eq(tasks.lifecycle, "active"),
        or(isNull(tasks.paused_at), sql`${tasks.paused_reason} <> 'owner_unavailable'`),
      ),
    )
    .orderBy(asc(tasks.id))
    .for("update");
  const at = deps.now();
  for (const row of rows) {
    await setPaused(tx, tenant_id, row, SYSTEM_ACTOR, "owner_unavailable", at);
    await closeOpenRun(tx, deps, {
      tenant_id,
      task_id: row.id,
      actor: SYSTEM_ACTOR,
      at,
      effects,
      reason: "owner_unavailable",
    });
    await deps.revokeTaskGrantsForTaskLocked(
      tx,
      { tenant_id, task_id: row.id },
      { type: "system" },
      "owner_unavailable",
    );
  }
  return rows.map((row) => row.id);
}

export async function pauseTasksOfOwner(
  tenant_id: string,
  user_id: string,
  db: Db,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<string[]> {
  return await withTaskEffects(db, (tx, effects) =>
    pauseTasksOfOwnerLocked(tx, tenant_id, user_id, effects, overrides),
  );
}

export async function getTask(
  p: TaskScope & { task_id: string; include_archived?: boolean },
  db: Executor,
): Promise<Task | null> {
  const [row] = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.tenant_id, p.tenant_id),
        eq(tasks.id, p.task_id),
        p.include_archived ? undefined : eq(tasks.lifecycle, "active"),
        taskVisibility(p),
      ),
    )
    .limit(1);
  return row ? rowToTask(row) : null;
}

function listFilter(p: ListTasksParams) {
  const q = p.q?.trim();
  const pattern = q ? `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : null;
  return and(
    eq(tasks.tenant_id, p.tenant_id),
    eq(tasks.lifecycle, p.lifecycle ?? "active"),
    taskVisibility(p),
    p.owner_id ? eq(tasks.owner_id, p.owner_id) : undefined,
    p.source_conversation_id
      ? eq(tasks.source_conversation_id, p.source_conversation_id)
      : undefined,
    p.category ? eq(tasks.category, p.category) : undefined,
    pattern
      ? or(
          ilike(tasks.name, pattern),
          ilike(tasks.goal, pattern),
          ilike(tasks.description, pattern),
        )
      : undefined,
  );
}

export async function listTasks(p: ListTasksParams, db: Executor): Promise<Task[]> {
  const column =
    p.sort === "name" ? tasks.name : p.sort === "created_at" ? tasks.created_at : tasks.updated_at;
  const direction = (p.order ?? (p.sort === "name" ? "asc" : "desc")) === "asc" ? asc : desc;
  const rows = await db
    .select()
    .from(tasks)
    .where(listFilter(p))
    .orderBy(direction(column), asc(tasks.id))
    .limit(Math.min(Math.max(p.limit ?? 50, 1), 200))
    .offset(Math.max(p.offset ?? 0, 0));
  return rows.map(rowToTask);
}

export async function countTasks(p: ListTasksParams, db: Executor): Promise<number> {
  const [row] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(tasks)
    .where(listFilter(p));
  return row?.total ?? 0;
}

interface ToolCallScope {
  readonly tenant_id: string;
  readonly conversation_id: string;
  readonly tool_call_id: string | null;
}

export async function readTaskSourceOfToolCall(
  db: Executor,
  scope: ToolCallScope,
): Promise<TaskSource | null> {
  const [call] = scope.tool_call_id
    ? await db
        .select({ created_at: conversationToolCalls.created_at })
        .from(conversationToolCalls)
        .where(
          and(
            eq(conversationToolCalls.tenant_id, scope.tenant_id),
            eq(conversationToolCalls.conversation_id, scope.conversation_id),
            eq(conversationToolCalls.id, scope.tool_call_id),
          ),
        )
        .limit(1)
    : [];
  const askedAt = call?.created_at ?? new Date();
  const messages = await db
    .select({
      id: conversationMessages.id,
      role: conversationMessages.role,
      created_at: conversationMessages.created_at,
    })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, scope.tenant_id),
        eq(conversationMessages.conversation_id, scope.conversation_id),
        eq(conversationMessages.role, "user"),
        lte(conversationMessages.created_at, askedAt),
      ),
    )
    .orderBy(desc(conversationMessages.created_at))
    .limit(1);
  return taskSource(scope.conversation_id, taskSourceMessageId(messages, askedAt));
}
