import { afterAll, beforeAll } from "bun:test";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import {
  auditLog,
  conversations,
  events,
  roles,
  taskGrants,
  users,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import {
  createTask,
  defaultTaskServiceDeps,
  startTaskRun,
  type Task,
  type TaskCreateInput,
  type TaskPlaybookFacts,
  type TaskRun,
  type TaskRunObservation,
  type TaskServiceDeps,
} from "../index.ts";

export const NOW = new Date("2026-11-19T08:00:00.000Z");
export let ctx: TestDb;
let sequence = 0;

export function useTaskDb(label: string): void {
  beforeAll(async () => {
    ctx = await createTestDb(label);
  }, 120_000);
  afterAll(async () => {
    await ctx.cleanup();
  });
}

export interface Workspace {
  tenant_id: string;
  owner: ResolvedPrincipal;
  member: ResolvedPrincipal;
  admin: ResolvedPrincipal;
}

async function person(tenant_id: string, role: string): Promise<ResolvedPrincipal> {
  const [roleRow] = await ctx.db
    .select({ id: roles.id })
    .from(roles)
    .where(and(isNull(roles.tenant_id), eq(roles.name, role)))
    .limit(1);
  if (!roleRow) throw new Error(`missing role ${role}`);
  const [user] = await ctx.db
    .insert(users)
    .values({ tenant_id, email: `${role}-${++sequence}@tasks.test`, role_id: roleRow.id })
    .returning({ id: users.id });
  if (!user) throw new Error("missing user");
  return { provider: "session", kind: "user", id: user.id, tenant_id, roles: [role] };
}

export async function workspace(): Promise<Workspace> {
  const tenant_id = (await seedTenant(ctx.db)).id;
  return {
    tenant_id,
    owner: await person(tenant_id, "member"),
    member: await person(tenant_id, "member"),
    admin: await person(tenant_id, "admin"),
  };
}

export function taskInput(overrides: Partial<TaskCreateInput> = {}): TaskCreateInput {
  return {
    name: "Weekly report",
    description: null,
    goal: "Send the weekly report",
    done_when: "The report is in the inbox",
    plan: {
      title: "Weekly report",
      goal: "Send the weekly report",
      steps: [
        {
          id: "collect",
          label: "Collect the numbers",
          criterion: { kind: "assessment", description: "Numbers are complete", result: null },
          depends_on: [],
          evidence_ids: [],
          note: null,
          progress: "open",
          next_action: null,
        },
      ],
      cancelled: false,
      completion_step_id: null,
    },
    bindings: { workflow_ids: [], connector_ids: [], skill_slugs: [], web_search: false },
    environment: "dev",
    schedule_cron: null,
    schedule_timezone: null,
    schedule_run_at: null,
    max_turns: 20,
    run_deadline_minutes: 240,
    ...overrides,
  };
}

export interface Recorded {
  admissions: string[];
  outcomes: string[];
  webhooks: string[];
  cleared: string[];
  payloads: unknown[];
  enqueued: string[];
  turn_cancels: string[];
  revocations: Array<[string, string, string | null]>;
}

export function recordingDeps(overrides: Partial<TaskServiceDeps> = {}): {
  deps: Partial<TaskServiceDeps>;
  seen: Recorded;
} {
  const seen: Recorded = {
    admissions: [],
    outcomes: [],
    webhooks: [],
    cleared: [],
    payloads: [],
    enqueued: [],
    turn_cancels: [],
    revocations: [],
  };
  return {
    seen,
    deps: {
      now: () => NOW,
      aiAccessConfigured: async () => true,
      recordTaskAdmission: (args) => {
        seen.admissions.push(args.reason);
      },
      recordTaskRunOutcome: (args) => {
        seen.outcomes.push(args.outcome);
      },
      emitTaskRunEvent: async (_tx, _tenant_id, type, payload) => {
        seen.webhooks.push(type);
        seen.payloads.push(payload);
      },
      revokeTaskGrantsForTaskLocked: async (tx, ref, actor, reason) => {
        seen.revocations.push([ref.task_id, reason, actor.type === "user" ? actor.id : null]);
        return await defaultTaskServiceDeps.revokeTaskGrantsForTaskLocked(tx, ref, actor, reason);
      },
      clearRunCheck: async (_db, params) => {
        seen.cleared.push(params.conversation_id);
      },
      cancelRunTurn: async (_db, params) => {
        seen.turn_cancels.push(params.conversation_id);
      },
      enqueueRunTurn: async (_db, params) => {
        seen.enqueued.push(params.task_run_id);
      },
      ...overrides,
    },
  };
}

export async function auditRows(tenant_id: string, resource_id: string) {
  return await ctx.db
    .select({
      action: auditLog.action,
      actor_type: auditLog.actor_type,
      actor_id: auditLog.actor_id,
      result: auditLog.result,
      reason: auditLog.reason,
      metadata: auditLog.metadata,
      before: auditLog.before,
      after: auditLog.after,
      trace_id: auditLog.trace_id,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.resource_id, resource_id)))
    .orderBy(asc(auditLog.ts), asc(auditLog.id));
}

export async function auditActions(tenant_id: string, resource_id: string): Promise<string[]> {
  return (await auditRows(tenant_id, resource_id)).map((row) => row.action);
}

export async function changeEvents(tenant_id: string, type: string) {
  return await ctx.db
    .select({ payload: events.payload })
    .from(events)
    .where(and(eq(events.tenant_id, tenant_id), eq(events.type, type)))
    .orderBy(asc(events.id));
}

export async function ownedTask(w: Workspace, input = taskInput()): Promise<Task> {
  return await createTask({ tenant_id: w.tenant_id, principal: w.owner, input }, ctx.db, {
    now: () => NOW,
  });
}

export async function started(
  w: Workspace,
  task: Task,
  deps: Partial<TaskServiceDeps>,
  by: Workspace["owner"] = w.owner,
): Promise<TaskRun> {
  const result = await startTaskRun(
    { tenant_id: w.tenant_id, task_id: task.id, trigger: "manual", started_by: by },
    ctx.db,
    deps,
  );
  if (!result.admitted) throw new Error(`not admitted: ${result.reason}`);
  return result.run;
}

let turns = 0;

export function nextTurn(): string {
  return `00000000-0000-4000-8000-${String(++turns).padStart(12, "0")}`;
}

export function facts(overrides: Partial<TaskPlaybookFacts> = {}): TaskPlaybookFacts {
  return {
    status: "in_progress",
    revision: 2,
    intact: true,
    result_confirmed: false,
    awaiting_result_confirmation: false,
    ...overrides,
  };
}

export function observed(overrides: Partial<TaskRunObservation> = {}): TaskRunObservation {
  return {
    conversation_status: "active",
    pending_elicitation: null,
    playbook: facts(),
    requested_check_at: null,
    turn_id: null,
    turn_seq: null,
    turn_driver: "task",
    turn_failure: null,
    turn_interrupted: false,
    human_input_since_last_turn: false,
    result_confirmed_by: null,
    result_rejected: false,
    ...overrides,
  };
}

export async function grantFor(
  w: Workspace,
  task: Task,
  overrides: Partial<typeof taskGrants.$inferInsert> = {},
): Promise<string> {
  const [row] = await ctx.db
    .insert(taskGrants)
    .values({
      tenant_id: w.tenant_id,
      task_id: task.id,
      fingerprint: task.fingerprint,
      environment: task.environment,
      valid_from: new Date(NOW.getTime() - 86_400_000),
      created_by: w.owner.id,
      ...overrides,
    })
    .returning({ id: taskGrants.id });
  if (!row) throw new Error("missing grant");
  return row.id;
}

export async function grantRow(tenant_id: string, id: string) {
  const [row] = await ctx.db
    .select()
    .from(taskGrants)
    .where(and(eq(taskGrants.tenant_id, tenant_id), eq(taskGrants.id, id)));
  if (!row) throw new Error("missing grant");
  return row;
}

export async function conversationRow(tenant_id: string, id: string) {
  const [row] = await ctx.db
    .select()
    .from(conversations)
    .where(and(eq(conversations.tenant_id, tenant_id), eq(conversations.id, id)));
  if (!row) throw new Error("missing conversation");
  return row;
}
