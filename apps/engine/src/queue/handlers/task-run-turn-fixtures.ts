import { afterAll, beforeAll } from "bun:test";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { humanConfirmationContextFingerprint } from "../../conversations/playbook-evidence.ts";
import type { PlaybookPlan } from "../../conversations/public/authoring.ts";
import { respondElicitation } from "../../conversations/public/elicitation.ts";
import {
  registerConversationAbort,
  unregisterConversationAbort,
} from "../../conversations/public/lifecycle.ts";
import type { Db } from "../../db/client.ts";
import {
  auditLog,
  conversationElicitations,
  conversations,
  roles,
  taskRuns,
  users,
} from "../../db/schema/index.ts";
import {
  type ConverseMockStep,
  getMockProvider,
  resetMockProvider,
} from "../../llm/mock-provider.ts";
import { withContext } from "../../logging/context.ts";
import {
  createTask,
  startTaskRun,
  type Task,
  type TaskCreateInput,
  type TaskServiceDeps,
} from "../../tasks/index.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { TASK_RUN_TURN_QUEUE } from "../queues.ts";
import { createQueueCtx, type QueueTestCtx } from "../tests/setup.ts";
import { ensureTestConfig } from "../tests/test-config.ts";
import {
  handleTaskRunTurnJob,
  registerTaskRunTurnListener,
  type TaskRunTurnHandlerDeps,
  type TaskRunTurnJob,
  useTaskRunTurnBoss,
} from "./task-run-turn.ts";

export let queue: QueueTestCtx;
export let db: Db;
export let boss: PgBoss;
let sequence = 0;

export const GOAL = "Send the weekly report";

export function useTaskRunQueue(label: string): void {
  beforeAll(async () => {
    testEnv.LLM_PROVIDER = "mock";
    await ensureTestConfig();
    resetMockProvider();
    queue = await createQueueCtx(label);
    db = queue.testDb.db;
    boss = queue.boss;
    useTaskRunTurnBoss(boss);
    registerTaskRunTurnListener();
  }, 120_000);
  afterAll(async () => {
    useTaskRunTurnBoss(null);
    await queue.cleanup();
  }, 60_000);
}

export interface Workspace {
  tenant_id: string;
  owner: ResolvedPrincipal;
  admin: ResolvedPrincipal;
}

export async function person(tenant_id: string, role: string): Promise<ResolvedPrincipal> {
  const [roleRow] = await db
    .select({ id: roles.id })
    .from(roles)
    .where(and(isNull(roles.tenant_id), eq(roles.name, role)))
    .limit(1);
  if (!roleRow) throw new Error(`missing role ${role}`);
  const [user] = await db
    .insert(users)
    .values({ tenant_id, email: `${role}-${++sequence}@driver.test`, role_id: roleRow.id })
    .returning({ id: users.id });
  if (!user) throw new Error("missing user");
  return { provider: "session", kind: "user", id: user.id, tenant_id, roles: [role] };
}

export async function workspace(): Promise<Workspace> {
  const tenant_id = (await seedTenant(db)).id;
  return {
    tenant_id,
    owner: await person(tenant_id, "member"),
    admin: await person(tenant_id, "admin"),
  };
}

export function taskInput(overrides: Partial<TaskCreateInput> = {}): TaskCreateInput {
  return {
    name: "Weekly report",
    description: null,
    goal: GOAL,
    done_when: "The report is in the inbox",
    plan: {
      title: "Weekly report",
      goal: GOAL,
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

export async function ownedTask(
  w: Workspace,
  input = taskInput(),
  deps: Partial<TaskServiceDeps> = {},
): Promise<Task> {
  return await createTask(
    { locale: "de", tenant_id: w.tenant_id, principal: w.owner, input },
    db,
    deps,
  );
}

export interface StartedRun {
  id: string;
  task_id: string;
  conversation_id: string;
  trace_id: string;
}

export async function startedRun(w: Workspace, task: Task): Promise<StartedRun> {
  const result = await startTaskRun(
    { tenant_id: w.tenant_id, task_id: task.id, trigger: "manual", started_by: w.owner },
    db,
  );
  if (!result.admitted) throw new Error(`not admitted: ${result.reason}`);
  if (!result.run.conversation_id) throw new Error("run has no conversation");
  return {
    id: result.run.id,
    task_id: task.id,
    conversation_id: result.run.conversation_id,
    trace_id: result.run.trace_id,
  };
}

export function jobOf(w: Workspace, run: StartedRun): TaskRunTurnJob {
  return { tenant_id: w.tenant_id, task_id: run.task_id, task_run_id: run.id };
}

export async function runRow(w: Workspace, run_id: string) {
  const [row] = await db
    .select()
    .from(taskRuns)
    .where(and(eq(taskRuns.tenant_id, w.tenant_id), eq(taskRuns.id, run_id)));
  if (!row) throw new Error("missing run");
  return row;
}

export function script(conversation_id: string, steps: ConverseMockStep[]): void {
  getMockProvider().setConversePlan(conversation_id, steps);
}

export async function queuedJobs(run_id: string) {
  const jobs = await boss.findJobs<TaskRunTurnJob>(TASK_RUN_TURN_QUEUE, {
    key: `task-run:${run_id}`,
  });
  return jobs.filter((job) => job.state === "created" || job.state === "active");
}

export async function clearQueue(): Promise<void> {
  for (;;) {
    const jobs = await boss.fetch<TaskRunTurnJob>(TASK_RUN_TURN_QUEUE);
    if (jobs.length === 0) return;
    for (const job of jobs) await boss.complete(TASK_RUN_TURN_QUEUE, job.id);
  }
}

export async function workQueuedTurn(deps: Partial<TaskRunTurnHandlerDeps> = {}): Promise<boolean> {
  const [job] = await boss.fetch<TaskRunTurnJob>(TASK_RUN_TURN_QUEUE);
  if (!job) return false;
  await handleTaskRunTurnJob(job, db, boss, deps);
  await boss.complete(TASK_RUN_TURN_QUEUE, job.id);
  return true;
}

export async function storedPlan(w: Workspace, conversation_id: string): Promise<PlaybookPlan> {
  const [row] = await db
    .select({ playbook: conversations.playbook })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, w.tenant_id), eq(conversations.id, conversation_id)));
  if (!row) throw new Error("missing conversation");
  return (row.playbook as { plan: PlaybookPlan }).plan;
}

export async function deliveredPlan(w: Workspace, conversation_id: string): Promise<PlaybookPlan> {
  const plan = await storedPlan(w, conversation_id);
  return {
    ...plan,
    steps: plan.steps.map((step) =>
      step.criterion.kind === "assessment"
        ? { ...step, criterion: { ...step.criterion, result: "All numbers collected." } }
        : step,
    ),
  };
}

export async function pendingElicitation(w: Workspace, conversation_id: string) {
  const [row] = await db
    .select()
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, w.tenant_id),
        eq(conversationElicitations.conversation_id, conversation_id),
        eq(conversationElicitations.status, "pending"),
      ),
    );
  if (!row) throw new Error("no pending elicitation");
  return row;
}

export const KEEPS_QUESTIONS: Partial<TaskRunTurnHandlerDeps> = {
  service: { cancelRunQuestions: async () => undefined },
};

export async function leftoverGoalQuestion(w: Workspace, conversation_id: string): Promise<void> {
  const pending = await pendingElicitation(w, conversation_id);
  const [conversation] = await db
    .select({ playbook: conversations.playbook, draft: conversations.draft })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, w.tenant_id), eq(conversations.id, conversation_id)));
  await db
    .update(conversationElicitations)
    .set({
      summary: GOAL,
      input: { ...(pending.input as object), question: GOAL },
      playbook_context_fingerprint: humanConfirmationContextFingerprint(
        conversation?.playbook,
        GOAL,
        conversation?.draft,
      ),
    })
    .where(
      and(
        eq(conversationElicitations.tenant_id, w.tenant_id),
        eq(conversationElicitations.id, pending.id),
      ),
    );
}

export async function answerAsPerson(
  w: Workspace,
  conversation_id: string,
  principal: ResolvedPrincipal,
  output: unknown,
  channel: "browser_session" | "mcp_oauth" = "browser_session",
): Promise<void> {
  await withContext({ audit_access_type: channel }, () =>
    answerOverChannel(w, conversation_id, principal, output),
  );
}

async function answerOverChannel(
  w: Workspace,
  conversation_id: string,
  principal: ResolvedPrincipal,
  output: unknown,
): Promise<void> {
  const pending = await pendingElicitation(w, conversation_id);
  const ctrl = await registerConversationAbort(w.tenant_id, conversation_id, db);
  try {
    await respondElicitation(
      {
        tenant_id: w.tenant_id,
        conversation_id,
        elicitation_id: pending.id,
        actor_id: principal.id,
        principal,
        answer_actor: { kind: "human", user_id: principal.id, via: "chat" },
        output,
        turn_abort_ctrl: ctrl,
        surface: "web",
      },
      db,
    );
  } finally {
    await unregisterConversationAbort(w.tenant_id, conversation_id, ctrl);
  }
}

export async function auditOf(tenant_id: string, resource_id: string) {
  return await db
    .select({
      action: auditLog.action,
      result: auditLog.result,
      reason: auditLog.reason,
      trace_id: auditLog.trace_id,
      metadata: auditLog.metadata,
    })
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.resource_id, resource_id)))
    .orderBy(asc(auditLog.ts), asc(auditLog.id));
}
