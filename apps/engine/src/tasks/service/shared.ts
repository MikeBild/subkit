import { and, eq } from "drizzle-orm";
import { catalogMetadataView } from "../../api/catalog-metadata.ts";
import type { AuditActorType } from "../../audit/types.ts";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  clearTaskRunCheck,
  createConversation,
  PlaybookPlanSchema,
  setConversationLoadedSkills,
  type TaskRunMarker,
  updatePlaybook,
} from "../../conversations/public/authoring.ts";
import { cancelOpenTaskRunQuestions } from "../../conversations/public/elicitation.ts";
import {
  cancelConversation,
  cancelConversationAbort,
} from "../../conversations/public/lifecycle.ts";
import type { Db, Executor, Transaction } from "../../db/client.ts";
import {
  roles,
  type taskGrants,
  type taskRuns,
  tasks,
  tenants,
  users,
} from "../../db/schema/index.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "../../http/errors.ts";
import { checkAndDecrement } from "../../llm/accounting/budget.ts";
import { workspaceAiAccess } from "../../llm/runtime/workspace-access.ts";
import { errorFields, logger } from "../../logging/index.ts";
import { recordTaskAdmission, recordTaskRunOutcome } from "../../observability/task-metrics.ts";
import { hasBuiltinAdminRole } from "../../rbac/evaluator.ts";
import { now } from "../../utils/clock.ts";
import { emitTaskRunEvent } from "../../webhooks/events/catalog.ts";
import type { TaskGrantAuthorityRevocationReason } from "../../workflows/execution-authorities.ts";
import { normalizeFailureCode } from "../core/failure-codes.ts";
import type { TaskGrantFacts } from "../core/grant.ts";
import { instantiateTaskPlan } from "../core/plan-instance.ts";
import { taskRunLoadedSkills } from "../core/run-start.ts";
import { reserveTaskGrantRun, type TaskGrantReservation } from "../grants/reservation.ts";
import {
  revokeTaskGrantsForTaskLocked,
  type TaskGrantLifecycleActor,
} from "../grants/revocation.ts";
import { conversationLoadedSkills } from "../persistence/run-start-rows.ts";
import type {
  Task,
  TaskAdmissionReason,
  TaskGrant,
  TaskPlan,
  TaskRun,
  TaskRunFailureCode,
  TaskRunTrigger,
  TaskRunWaitingReason,
} from "../types.ts";

export type TaskRow = typeof tasks.$inferSelect;
export type TaskLocale = TaskRow["locale"];
export type TaskRunRow = typeof taskRuns.$inferSelect;
export type TaskGrantRow = typeof taskGrants.$inferSelect;

export type TaskRunWebhookEvent =
  | "task_run.started"
  | "task_run.waiting"
  | "task_run.result_ready"
  | "task_run.completed"
  | "task_run.failed";

interface TaskRunEventBase {
  task_run_id: string;
  task_id: string;
  trigger: TaskRunTrigger;
}

export interface TaskRunEventPayloads {
  "task_run.started": TaskRunEventBase & { environment: "dev" | "prod" };
  "task_run.waiting": TaskRunEventBase & { waiting_reason: TaskRunWaitingReason };
  "task_run.result_ready": TaskRunEventBase & { turns_used: number };
  "task_run.completed": TaskRunEventBase & { turns_used: number; duration_ms: number };
  "task_run.failed": TaskRunEventBase & { failure_code: TaskRunFailureCode | null };
}

export interface TaskOwnerFacts {
  active: boolean;
  roles: string[];
  email: string | null;
}

export interface RunConversationOpening {
  tenant_id: string;
  owner_id: string;
  principal: ResolvedPrincipal;
  title: string;
  task_run: TaskRunMarker;
  plan_template: unknown;
  goal: string;
  started_at: string;
  skills: readonly string[];
}

export interface TaskServiceDeps {
  now(): Date;
  openRunConversation(db: Db, opening: RunConversationOpening): Promise<string>;
  loadOwner(db: Executor, tenant_id: string, owner_id: string): Promise<TaskOwnerFacts>;
  aiAccessConfigured(db: Executor, tenant_id: string): Promise<boolean>;
  llmBudgetAvailable(
    db: Executor,
    tenant_id: string,
    owner_id: string,
    projected_tokens?: number | null,
  ): Promise<boolean>;
  reserveTaskGrantRun(
    tx: Executor,
    ref: { tenant_id: string; grant_id: string },
  ): Promise<TaskGrantReservation>;
  revokeTaskGrantsForTaskLocked(
    tx: Executor,
    task: { tenant_id: string; task_id: string },
    actor: TaskGrantLifecycleActor,
    reason_code: TaskGrantAuthorityRevocationReason,
  ): Promise<unknown>;
  emitTaskRunEvent<T extends TaskRunWebhookEvent>(
    tx: Executor,
    tenant_id: string,
    type: T,
    payload: TaskRunEventPayloads[T],
  ): Promise<unknown>;
  recordTaskAdmission(args: { reason: TaskAdmissionReason }): void;
  recordTaskRunOutcome(args: {
    tenant_id: string;
    outcome: "started" | "completed" | "failed" | "aborted";
    trigger: TaskRunTrigger;
    duration_ms: number;
  }): void;
  cancelRunConversation(
    db: Db,
    params: {
      tenant_id: string;
      conversation_id: string;
      actor: TaskActor;
      principal?: ResolvedPrincipal | null;
    },
  ): Promise<void>;
  cancelRunTurn(db: Db, params: { tenant_id: string; conversation_id: string }): Promise<void>;
  clearRunCheck(db: Db, params: { tenant_id: string; conversation_id: string }): Promise<void>;
  cancelRunQuestions(
    db: Db,
    params: {
      tenant_id: string;
      task_id: string;
      conversation_id: string;
      state: TaskRunSettledState;
    },
  ): Promise<void>;
  enqueueRunTurn(
    db: Db,
    params: { tenant_id: string; task_id: string; task_run_id: string },
  ): Promise<void>;
}

export const SYSTEM_SCOPE: unique symbol = Symbol("tasks.system_scope");

export type TaskPrincipal = ResolvedPrincipal | typeof SYSTEM_SCOPE;

export interface TaskScope {
  tenant_id: string;
  principal: TaskPrincipal;
}

export interface TaskActor {
  actor_type: AuditActorType;
  actor_id: string | null;
}

export const SYSTEM_ACTOR: TaskActor = { actor_type: "system", actor_id: null };

export function actorOf(principal: TaskPrincipal): TaskActor {
  if (principal === SYSTEM_SCOPE) return SYSTEM_ACTOR;
  if (!principal) throw new ForbiddenError("task_principal_required");
  return { actor_type: principal.kind, actor_id: principal.id };
}

export function grantActor(actor: TaskActor): TaskGrantLifecycleActor {
  return actor.actor_type === "user" && actor.actor_id
    ? { type: "user", id: actor.actor_id }
    : { type: "system" };
}

function seesAllTasks(principal: TaskPrincipal): boolean {
  if (principal === SYSTEM_SCOPE) return true;
  if (!principal) throw new ForbiddenError("task_principal_required");
  return hasBuiltinAdminRole(principal);
}

export function mayActOnTask(principal: TaskPrincipal, owner_id: string): boolean {
  return seesAllTasks(principal) || (principal as ResolvedPrincipal).id === owner_id;
}

export interface TaskEffects {
  after: Array<(db: Db) => Promise<void> | void>;
}

export function taskEffects(): TaskEffects {
  return { after: [] };
}

export async function settleTaskEffects(db: Db, effects: TaskEffects): Promise<void> {
  let failure: unknown;
  for (const effect of effects.after) {
    try {
      await effect(db);
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
}

export async function withTaskEffects<T>(
  db: Db,
  work: (tx: Transaction, effects: TaskEffects) => Promise<T>,
): Promise<T> {
  const effects = taskEffects();
  const result = await db.transaction((tx) => {
    effects.after.length = 0;
    return work(tx, effects);
  });
  await settleTaskEffects(db, effects);
  return result;
}

export function taskVisibility(scope: TaskScope) {
  return seesAllTasks(scope.principal)
    ? undefined
    : eq(tasks.owner_id, (scope.principal as ResolvedPrincipal).id);
}

export async function lockTask(
  tx: Executor,
  scope: TaskScope,
  task_id: string,
  options: { include_archived?: boolean } = {},
): Promise<TaskRow> {
  const [row] = await tx
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.tenant_id, scope.tenant_id),
        eq(tasks.id, task_id),
        options.include_archived ? undefined : eq(tasks.lifecycle, "active"),
        taskVisibility(scope),
      ),
    )
    .for("update")
    .limit(1);
  if (!row) throw new NotFoundError("task");
  return row;
}

export async function loadTaskOwner(
  db: Executor,
  tenant_id: string,
  owner_id: string,
): Promise<TaskOwnerFacts> {
  const [row] = await db
    .select({
      role: roles.name,
      deleted: users.deleted_at,
      status: users.status,
      email: users.email,
    })
    .from(users)
    .leftJoin(roles, eq(roles.id, users.role_id))
    .where(and(eq(users.tenant_id, tenant_id), eq(users.id, owner_id)))
    .limit(1);
  return {
    active: Boolean(row?.role) && row?.deleted === null && row?.status === "active",
    roles: row?.role ? [row.role] : [],
    email: row?.email ?? null,
  };
}

export async function tenantAiAccessConfigured(db: Executor, tenant_id: string): Promise<boolean> {
  const [tenant] = await db
    .select({ origin: tenants.origin })
    .from(tenants)
    .where(eq(tenants.id, tenant_id))
    .limit(1);
  if (!tenant) return false;
  if (tenant.origin !== "self_service") return true;
  return workspaceAiAccess({ id: tenant_id, origin: tenant.origin }).configured;
}

export const TASK_TURN_COMPLETION_ALLOWANCE = 1024;

export async function tenantLlmBudgetAvailable(
  db: Executor,
  tenant_id: string,
  _owner_id: string,
  projected_tokens: number | null = null,
): Promise<boolean> {
  const verdict = await checkAndDecrement(
    tenant_id,
    projected_tokens ?? TASK_TURN_COMPLETION_ALLOWANCE,
    db,
  );
  return verdict.ok;
}

export type TaskRunSettledState = "result_ready" | "completed" | "failed" | "aborted";

async function withdrawRunQuestions(
  db: Db,
  params: {
    tenant_id: string;
    task_id: string;
    conversation_id: string;
    state: TaskRunSettledState;
  },
): Promise<void> {
  try {
    await cancelOpenTaskRunQuestions(db, {
      tenant_id: params.tenant_id,
      conversation_id: params.conversation_id,
      outcome: params.state === "result_ready" ? "result_ready" : "ended",
    });
  } catch (error) {
    logger.warn({
      module: "tasks",
      action: "task_run.questions_not_withdrawn",
      msg: "the run state is recorded, but an open question of its conversation was not withdrawn",
      tenant_id: params.tenant_id,
      conversation_id: params.conversation_id,
      ...errorFields(error),
    });
  }
}

async function openRunConversation(db: Db, opening: RunConversationOpening): Promise<string> {
  const plan = instantiateTaskPlan(PlaybookPlanSchema.parse(opening.plan_template), {
    goal: opening.goal,
    started_at: opening.started_at,
  });
  const { conversation } = await createConversation(
    {
      tenant_id: opening.tenant_id,
      actor_id: opening.owner_id,
      principal: opening.principal,
      title: opening.title,
      surface: "web",
      playbook_mode: "auto",
      task_run: opening.task_run,
    },
    db,
  );
  const scope = { tenant_id: opening.tenant_id, conversation_id: conversation.id };
  const loaded = taskRunLoadedSkills(await conversationLoadedSkills(db, scope), opening.skills);
  if (loaded) await setConversationLoadedSkills(db, scope, loaded);
  await updatePlaybook(
    db,
    { ...scope, principal: opening.principal },
    { expected_revision: 0, plan },
  );
  return conversation.id;
}

export const defaultTaskServiceDeps: TaskServiceDeps = {
  now: () => new Date(now()),
  openRunConversation,
  loadOwner: loadTaskOwner,
  aiAccessConfigured: tenantAiAccessConfigured,
  llmBudgetAvailable: tenantLlmBudgetAvailable,
  reserveTaskGrantRun,
  revokeTaskGrantsForTaskLocked,
  emitTaskRunEvent: (tx, tenant_id, type, payload) =>
    emitTaskRunEvent(tx, tenant_id, type, payload as never),
  recordTaskAdmission,
  recordTaskRunOutcome,
  cancelRunConversation: async (db, params) => {
    const bySystem = params.actor.actor_type === "system";
    await cancelConversation(
      params.tenant_id,
      params.conversation_id,
      bySystem ? null : params.actor.actor_id,
      db,
      params.actor.actor_type,
      bySystem ? null : (params.principal ?? null),
    );
  },
  cancelRunTurn: async (_db, params) => {
    cancelConversationAbort(params.tenant_id, params.conversation_id);
  },
  clearRunCheck: (db, params) => clearTaskRunCheck(db, params),
  cancelRunQuestions: withdrawRunQuestions,
  enqueueRunTurn: async (db, params) => {
    const queue = await import("../../queue/handlers/task-run-turn.ts");
    await queue.enqueueTaskRunTurn(db, params);
  },
};

export function taskServiceDeps(overrides: Partial<TaskServiceDeps> = {}): TaskServiceDeps {
  return { ...defaultTaskServiceDeps, ...overrides };
}

const iso = (value: Date | null): string | null => (value ? value.toISOString() : null);

export function rowToTask(row: TaskRow): Task {
  const meta = catalogMetadataView(row);
  return {
    id: row.id,
    name: row.name,
    description: meta.description,
    category: meta.category,
    owner_id: row.owner_id,
    goal: row.goal,
    done_when: row.done_when,
    plan: row.plan as TaskPlan,
    bindings: row.bindings,
    environment: row.environment,
    schedule_cron: row.schedule_cron,
    schedule_timezone: row.schedule_timezone,
    schedule_run_at: iso(row.schedule_run_at),
    last_claimed_at: iso(row.last_claimed_at),
    paused_at: iso(row.paused_at),
    paused_by: row.paused_by,
    paused_reason: row.paused_reason,
    max_turns: row.max_turns,
    run_deadline_minutes: row.run_deadline_minutes,
    fingerprint: row.fingerprint,
    revision: row.revision,
    lifecycle: row.lifecycle,
    source_conversation_id: row.source_conversation_id,
    source_message_id: row.source_message_id,
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function rowToTaskRun(row: TaskRunRow): TaskRun {
  return {
    id: row.id,
    task_id: row.task_id,
    task_revision: row.task_revision,
    fingerprint: row.fingerprint,
    conversation_id: row.conversation_id,
    trigger: row.trigger,
    started_by: row.started_by,
    grant_id: row.grant_id,
    state: row.state,
    waiting_reason: row.waiting_reason,
    next_check_at: iso(row.next_check_at),
    sleep_reason: row.sleep_reason,
    deadline_at: row.deadline_at.toISOString(),
    turns_used: row.turns_used,
    no_progress_count: row.no_progress_count,
    last_seen_turn_id: row.last_seen_turn_id,
    last_playbook_revision: row.last_playbook_revision,
    trace_id: row.trace_id,
    failure_code: row.failure_code === null ? null : normalizeFailureCode(row.failure_code),
    result_ready_at: iso(row.result_ready_at),
    completed_at: iso(row.completed_at),
    completed_by: row.completed_by,
    ended_at: iso(row.ended_at),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function rowToTaskGrant(row: TaskGrantRow): TaskGrant {
  return {
    id: row.id,
    task_id: row.task_id,
    fingerprint: row.fingerprint,
    environment: row.environment,
    valid_from: row.valid_from.toISOString(),
    valid_until: iso(row.valid_until),
    max_runs: row.max_runs,
    reserved_runs: row.reserved_runs,
    created_by: row.created_by,
    created_at: row.created_at.toISOString(),
    revoked_at: iso(row.revoked_at),
    revoked_by: row.revoked_by,
    workflow_authority_ids: row.workflow_authority_ids,
  };
}

export function grantFacts(row: TaskGrantRow): TaskGrantFacts {
  return {
    fingerprint: row.fingerprint,
    valid_from: row.valid_from,
    valid_until: row.valid_until,
    max_runs: row.max_runs,
    reserved_runs: row.reserved_runs,
    revoked_at: row.revoked_at,
  };
}

export function taskRunStarterInvalid(): BadRequestError {
  return new BadRequestError("A person starts manual runs; scheduled runs start without one.", {
    code: "task_run_starter_invalid",
  });
}
