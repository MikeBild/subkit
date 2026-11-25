import { localConfirmationOf } from "@shared/device/confirmation.ts";
import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../auth/types.ts";
import {
  getTaskRunCheck,
  readConversationPlaybookPlan,
  readPlaybook,
  TASK_RUN_CONTINUATION_ORIGIN,
  type TurnFailure,
  updatePlaybook,
} from "../conversations/public/authoring.ts";
import {
  answerElicitationAsPerson,
  elicitationAnsweredInBrowser,
  interpretConfirmDecision,
} from "../conversations/public/elicitation.ts";
import {
  type ConversationTurnRelease,
  reconcileInterruptedConversationTurn,
} from "../conversations/public/lifecycle.ts";
import type { Db, Executor } from "../db/client.ts";
import {
  conversationElicitations,
  conversationMessages,
  conversations,
  conversationToolCalls,
  conversationTurns,
  taskRuns,
  tasks,
} from "../db/schema/index.ts";
import { errorFields, logger } from "../logging/index.ts";
import { type TaskRunToolCall, taskRunCallMarks } from "./core/progress.ts";
import {
  TASK_TURN_STOPPED,
  type TaskRunObservation,
  taskRunIsOpen,
  taskRunLimitReached,
} from "./core/run-state.ts";
import type { TaskRunSource } from "./service/run-rows.ts";
import {
  type RunObservationResult,
  readTaskRunPlaybook,
  recordRunObservation,
  resumeTaskRun,
  taskRunPrincipal,
} from "./service/runs.ts";
import {
  type TaskRow,
  type TaskRunRow,
  type TaskServiceDeps,
  taskServiceDeps,
} from "./service/shared.ts";

export const TASK_TURN_JOB_FAILURE_LIMIT = 3;

export {
  TASK_RUN_CONTINUATION_MESSAGE,
  TASK_RUN_LANGUAGE_INSTRUCTIONS,
  TASK_RUN_REJECTION_NOTICE,
  taskRunTurnKind,
  taskRunTurnPrompt,
} from "./core/turn-prompt.ts";

const PROVIDER_THROTTLE_FALLBACK_MS = 60_000;
const FINISHED_TURN_STATES = ["completed", "failed", "cancelled"] as const;
const ACTIVE_TURN_STATES = ["queued", "running", "parked"] as const;

export interface TaskRunTurnFacts {
  id: string | null;
  driver: "task" | "person";
  failure: { code: string; retry_at: Date | null } | null;
  interrupted: boolean;
}

export interface LoadedTaskRun {
  run: TaskRunRow;
  task: TaskRow;
}

export function taskRunTurnFailure(
  failure: TurnFailure,
  now: Date,
): { code: string; retry_at: Date | null } {
  if (failure.code !== "llm_provider_limited" && failure.code !== "llm_provider_quota_exhausted")
    return { code: failure.code, retry_at: null };
  const stated = failure.retry_at ? Date.parse(failure.retry_at) : Number.NaN;
  return {
    code: failure.code,
    retry_at:
      Number.isFinite(stated) && stated > now.getTime()
        ? new Date(stated)
        : new Date(now.getTime() + PROVIDER_THROTTLE_FALLBACK_MS),
  };
}

export function refusedTurnTokens(error: unknown): number | null {
  const projected = (error as { details?: { projected_tokens?: unknown } } | null)?.details
    ?.projected_tokens;
  return typeof projected === "number" && Number.isInteger(projected) && projected > 0
    ? projected
    : null;
}

export async function recordBudgetWait(
  db: Executor,
  p: { tenant_id: string; task_run_id: string; projected_tokens: number | null },
): Promise<void> {
  await db
    .update(taskRuns)
    .set({ budget_wait_tokens: p.projected_tokens })
    .where(and(eq(taskRuns.tenant_id, p.tenant_id), eq(taskRuns.id, p.task_run_id)));
}

export async function loadTaskRun(
  db: Executor,
  tenant_id: string,
  task_run_id: string,
): Promise<LoadedTaskRun | null> {
  const [row] = await db
    .select({ run: taskRuns, task: tasks })
    .from(taskRuns)
    .innerJoin(tasks, and(eq(tasks.tenant_id, taskRuns.tenant_id), eq(tasks.id, taskRuns.task_id)))
    .where(and(eq(taskRuns.tenant_id, tenant_id), eq(taskRuns.id, task_run_id)))
    .limit(1);
  return row ?? null;
}

export async function conversationTurnHeld(
  db: Executor,
  tenant_id: string,
  conversation_id: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: conversationTurns.id })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.tenant_id, tenant_id),
        eq(conversationTurns.conversation_id, conversation_id),
        inArray(conversationTurns.state, [...ACTIVE_TURN_STATES]),
      ),
    )
    .limit(1);
  return row !== undefined;
}

export async function conversationTurnSeq(
  db: Executor,
  tenant_id: string,
  conversation_id: string,
  turn_id: string,
): Promise<number | null> {
  const [row] = await db
    .select({ seq: sql<number>`count(*)::int` })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.tenant_id, tenant_id),
        eq(conversationTurns.conversation_id, conversation_id),
        sql`(${conversationTurns.created_at}, ${conversationTurns.id}) <= (
          SELECT own.created_at, own.id FROM conversation_turns own
           WHERE own.tenant_id = ${tenant_id} AND own.conversation_id = ${conversation_id}
             AND own.id = ${turn_id})`,
      ),
    )
    .limit(1);
  return row && row.seq > 0 ? row.seq : null;
}

function inputOf(row: { input: unknown }): Record<string, unknown> {
  return row.input && typeof row.input === "object" && !Array.isArray(row.input)
    ? (row.input as Record<string, unknown>)
    : {};
}

async function openQuestion(
  db: Executor,
  tenant_id: string,
  conversation_id: string,
): Promise<TaskRunObservation["pending_elicitation"]> {
  const [latest] = await db
    .select({
      status: conversationElicitations.status,
      input: conversationElicitations.input,
      updated_at: conversationElicitations.updated_at,
    })
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, tenant_id),
        eq(conversationElicitations.conversation_id, conversation_id),
      ),
    )
    .orderBy(
      sql`${conversationElicitations.status} = 'pending' DESC`,
      desc(conversationElicitations.created_at),
    )
    .limit(1);
  if (!latest) return null;
  if (latest.status === "pending") return inputOf(latest).commit_intent ? "approval" : "question";
  if (latest.status !== "timeout") return null;
  if (localConfirmationOf(latest.input) !== null) return null;
  const [later] = await db
    .select({ id: conversationTurns.id })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.tenant_id, tenant_id),
        eq(conversationTurns.conversation_id, conversation_id),
        gte(conversationTurns.created_at, latest.updated_at),
      ),
    )
    .limit(1);
  return later ? null : "question_expired";
}

async function resultDecision(
  db: Executor,
  p: { tenant_id: string; conversation_id: string; goal: string; turn_id: string | null },
): Promise<{ confirmed_by: string | null; rejected: boolean }> {
  const none = { confirmed_by: null, rejected: false };
  const [decision] = await db
    .select({
      id: conversationElicitations.id,
      status: conversationElicitations.status,
      output: conversationElicitations.output,
      decided_by: conversationElicitations.decided_by,
      decided_by_kind: conversationElicitations.decided_by_kind,
      in_turn: p.turn_id
        ? sql<boolean>`${conversationElicitations.decided_at} >= (
            SELECT own.created_at FROM conversation_turns own
             WHERE own.tenant_id = ${p.tenant_id} AND own.id = ${p.turn_id})`
        : sql<boolean>`false`,
    })
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.tenant_id, p.tenant_id),
        eq(conversationElicitations.conversation_id, p.conversation_id),
        eq(conversationElicitations.tool_name, "ask_user_confirm"),
        sql`${conversationElicitations.input}->>'question' = ${p.goal}`,
        sql`${conversationElicitations.input}->'commit_intent' IS NULL`,
      ),
    )
    .orderBy(desc(conversationElicitations.created_at))
    .limit(1);
  if (
    decision?.status !== "resolved" ||
    decision.decided_by_kind !== "user" ||
    !decision.decided_by
  )
    return none;
  const human = await elicitationAnsweredInBrowser(db, {
    tenant_id: p.tenant_id,
    elicitation_id: decision.id,
    decided_by: decision.decided_by,
  });
  if (!human) return none;
  const answer = interpretConfirmDecision(decision.output);
  if (answer === "confirmed") return { confirmed_by: decision.decided_by, rejected: false };
  return { confirmed_by: null, rejected: answer === "declined" && decision.in_turn === true };
}

async function taskRunToolCalls(
  db: Executor,
  tenant_id: string,
  conversation_id: string,
): Promise<TaskRunToolCall[]> {
  return await db
    .select({
      id: conversationToolCalls.id,
      tool: conversationToolCalls.tool,
      outcome: conversationToolCalls.outcome,
    })
    .from(conversationToolCalls)
    .where(
      and(
        eq(conversationToolCalls.tenant_id, tenant_id),
        eq(conversationToolCalls.conversation_id, conversation_id),
      ),
    )
    .orderBy(asc(conversationToolCalls.created_at), asc(conversationToolCalls.id));
}

function requestedCheck(draft: unknown): Date | null {
  const check = getTaskRunCheck(draft);
  if (!check) return null;
  const at = new Date(check.at);
  return Number.isNaN(at.getTime()) ? null : at;
}

export async function buildTaskRunObservation(
  db: Db,
  loaded: LoadedTaskRun,
  turn: TaskRunTurnFacts,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<TaskRunObservation> {
  const { run, task } = loaded;
  const person = turn.driver === "person";
  const base = {
    turn_id: turn.id,
    turn_driver: turn.driver,
    turn_failure: turn.failure,
    turn_interrupted: turn.interrupted,
    human_input_since_last_turn: person,
  };
  const empty: TaskRunObservation = {
    ...base,
    conversation_status: "missing",
    pending_elicitation: null,
    playbook: null,
    requested_check_at: null,
    turn_seq: null,
    progress_marks: [],
    result_confirmed_by: null,
    result_rejected: false,
  };
  const conversation_id = run.conversation_id;
  if (!conversation_id) return empty;
  const [conversation] = await db
    .select({ status: conversations.status, draft: conversations.draft })
    .from(conversations)
    .where(and(eq(conversations.tenant_id, run.tenant_id), eq(conversations.id, conversation_id)))
    .limit(1);
  if (!conversation) return empty;
  const scope = { tenant_id: run.tenant_id, conversation_id };
  const owner = await taskServiceDeps(overrides).loadOwner(db, run.tenant_id, task.owner_id);
  const decision = person
    ? await resultDecision(db, { ...scope, goal: task.goal, turn_id: turn.id })
    : { confirmed_by: null, rejected: false };
  const playbook = await readTaskRunPlaybook(
    {
      ...scope,
      principal: taskRunPrincipal(task, owner, run),
      goal: task.goal,
      locale: task.locale,
    },
    db,
  );
  return {
    ...base,
    conversation_status: conversation.status,
    pending_elicitation: await openQuestion(db, run.tenant_id, conversation_id),
    playbook,
    progress_marks: [
      ...(playbook?.progress_marks ?? []),
      ...taskRunCallMarks(await taskRunToolCalls(db, run.tenant_id, conversation_id)),
    ],
    requested_check_at: requestedCheck(conversation.draft),
    turn_seq: turn.id
      ? await conversationTurnSeq(db, run.tenant_id, conversation_id, turn.id)
      : null,
    result_confirmed_by: decision.confirmed_by,
    result_rejected: decision.rejected,
  };
}

export async function observeTaskRun(
  db: Db,
  p: {
    tenant_id: string;
    task_run_id: string;
    turn: TaskRunTurnFacts;
    source: TaskRunSource;
  },
  overrides: Partial<TaskServiceDeps> = {},
): Promise<RunObservationResult | null> {
  const loaded = await loadTaskRun(db, p.tenant_id, p.task_run_id);
  if (!loaded) return null;
  const observation = await buildTaskRunObservation(db, loaded, p.turn, overrides);
  return await recordRunObservation(
    { tenant_id: p.tenant_id, task_run_id: p.task_run_id, observation, source: p.source },
    db,
    overrides,
  );
}

async function enqueueNext(
  db: Db,
  run: { tenant_id: string; task_id: string; id: string },
  overrides: Partial<TaskServiceDeps>,
): Promise<void> {
  await taskServiceDeps(overrides).enqueueRunTurn(db, {
    tenant_id: run.tenant_id,
    task_id: run.task_id,
    task_run_id: run.id,
  });
}

const taskDrivenTurns = new Set<string>();

export function markTaskDrivenTurn(turn_id: string, driven: boolean): void {
  if (driven) taskDrivenTurns.add(turn_id);
  else taskDrivenTurns.delete(turn_id);
}

export async function observePersonTurn(
  release: ConversationTurnRelease,
  overrides: Partial<TaskServiceDeps> = {},
): Promise<RunObservationResult | null> {
  if (taskDrivenTurns.has(release.turn_id)) return null;
  const [run] = await release.db
    .select({ id: taskRuns.id, task_id: taskRuns.task_id, state: taskRuns.state })
    .from(taskRuns)
    .where(
      and(
        eq(taskRuns.tenant_id, release.tenant_id),
        eq(taskRuns.conversation_id, release.conversation_id),
      ),
    )
    .limit(1);
  if (!run || !taskRunTakesPersonTurns(run.state)) return null;
  const result = await observeTaskRun(
    release.db,
    {
      tenant_id: release.tenant_id,
      task_run_id: run.id,
      turn: {
        id: release.turn_id,
        driver: "person",
        failure: release.state === "cancelled" ? { code: TASK_TURN_STOPPED, retry_at: null } : null,
        interrupted: false,
      },
      source: "chat",
    },
    overrides,
  );
  if (result?.enqueue)
    await enqueueNext(release.db, { tenant_id: release.tenant_id, ...run }, overrides);
  return result;
}

async function unobservedTurn(
  db: Db,
  run: TaskRunRow,
  conversation_id: string,
): Promise<{ id: string; state: string; driver: "task" | "person" } | null> {
  const [turn] = await db
    .select({ id: conversationTurns.id, state: conversationTurns.state })
    .from(conversationTurns)
    .where(
      and(
        eq(conversationTurns.tenant_id, run.tenant_id),
        eq(conversationTurns.conversation_id, conversation_id),
        inArray(conversationTurns.state, [...FINISHED_TURN_STATES]),
      ),
    )
    .orderBy(desc(conversationTurns.created_at), desc(conversationTurns.id))
    .limit(1);
  if (!turn || turn.id === run.last_seen_turn_id) return null;
  const seq = await conversationTurnSeq(db, run.tenant_id, conversation_id, turn.id);
  if (seq === null || seq <= run.last_seen_turn_seq) return null;
  const [continuation] = await db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, run.tenant_id),
        eq(conversationMessages.conversation_id, conversation_id),
        eq(conversationMessages.role, "user"),
        sql`${conversationMessages.content}->>'origin' = ${TASK_RUN_CONTINUATION_ORIGIN}`,
        sql`${conversationMessages.created_at} >= (
          SELECT own.created_at FROM conversation_turns own
           WHERE own.tenant_id = ${run.tenant_id} AND own.id = ${turn.id})`,
      ),
    )
    .limit(1);
  return { ...turn, driver: continuation ? "task" : "person" };
}

function taskRunTakesPersonTurns(state: TaskRunRow["state"]): boolean {
  return taskRunIsOpen(state) || state === "result_ready";
}

export type TaskRunAdvance = "idle" | "observed" | "resumed" | "enqueued";

export async function advanceTaskRun(
  db: Db,
  p: { tenant_id: string; task_run_id: string; now: Date; dead_letter?: boolean },
  overrides: Partial<TaskServiceDeps> = {},
): Promise<TaskRunAdvance> {
  const loaded = await loadTaskRun(db, p.tenant_id, p.task_run_id);
  if (!loaded) return "idle";
  const { run } = loaded;
  const conversation_id = run.conversation_id;
  if (!taskRunTakesPersonTurns(run.state) || !conversation_id) return "idle";
  if (p.dead_letter && run.state !== "running") return "idle";
  const ref = { tenant_id: run.tenant_id, task_id: run.task_id, id: run.id };
  if (run.state === "sleeping") {
    if (run.sleep_reason === "paused" || !run.next_check_at || run.next_check_at > p.now)
      return "idle";
    const woken = await resumeTaskRun({ ...p, source: "scheduler" }, db, overrides);
    if (woken.resumed) await enqueueNext(db, ref, overrides);
    return woken.resumed ? "resumed" : "idle";
  }
  await reconcileInterruptedConversationTurn(db, run.tenant_id, conversation_id);
  if (await conversationTurnHeld(db, run.tenant_id, conversation_id)) return "idle";
  const turn = await unobservedTurn(db, run, conversation_id);
  if (turn) {
    if (run.state === "result_ready" && turn.driver !== "person") return "idle";
    const orphaned = turn.driver === "task" && turn.state !== "completed";
    const result = await observeTaskRun(
      db,
      {
        ...p,
        turn: {
          id: turn.id,
          driver: turn.driver,
          failure: turn.state === "cancelled" ? { code: TASK_TURN_STOPPED, retry_at: null } : null,
          interrupted: orphaned,
        },
        source: "scheduler",
      },
      overrides,
    );
    if (result?.enqueue && !p.dead_letter) await enqueueNext(db, ref, overrides);
    return "observed";
  }
  if (run.state === "result_ready") return "idle";
  if (run.state === "running") {
    if (p.dead_letter) {
      await db
        .update(taskRuns)
        .set({ turn_job_failures: sql`${taskRuns.turn_job_failures} + 1` })
        .where(
          and(
            eq(taskRuns.tenant_id, run.tenant_id),
            eq(taskRuns.id, run.id),
            eq(taskRuns.state, "running"),
          ),
        );
      return "idle";
    }
    if (run.turn_job_failures >= TASK_TURN_JOB_FAILURE_LIMIT) {
      await observeTaskRun(
        db,
        {
          ...p,
          turn: { id: null, driver: "task", failure: null, interrupted: true },
          source: "scheduler",
        },
        overrides,
      );
      return "observed";
    }
    await enqueueNext(db, ref, overrides);
    return "enqueued";
  }
  if (run.waiting_reason === "ai_access" || run.waiting_reason === "budget") {
    const deps = taskServiceDeps(overrides);
    const ready =
      run.waiting_reason === "ai_access"
        ? await deps.aiAccessConfigured(db, run.tenant_id)
        : await deps.llmBudgetAvailable(
            db,
            run.tenant_id,
            loaded.task.owner_id,
            run.budget_wait_tokens,
          );
    if (!ready) return "idle";
    const resumed = await resumeTaskRun({ ...p, source: "scheduler" }, db, overrides);
    if (resumed.resumed) await enqueueNext(db, ref, overrides);
    return resumed.resumed ? "resumed" : "idle";
  }
  if (run.waiting_reason === "no_progress" || run.waiting_reason === "turn_stopped") {
    if (!taskRunLimitReached(run, { max_turns: loaded.task.max_turns }, p.now)) return "idle";
    await observeTaskRun(
      db,
      {
        ...p,
        turn: { id: null, driver: "task", failure: null, interrupted: false },
        source: "scheduler",
      },
      overrides,
    );
    return "observed";
  }
  if (run.waiting_reason !== "question" && run.waiting_reason !== "approval") return "idle";
  const pending = await openQuestion(db, run.tenant_id, conversation_id);
  if (pending === run.waiting_reason) return "idle";
  const result = await observeTaskRun(
    db,
    {
      ...p,
      turn: {
        id: null,
        driver: pending === null ? "person" : "task",
        failure: null,
        interrupted: false,
      },
      source: "scheduler",
    },
    overrides,
  );
  if (result?.enqueue) await enqueueNext(db, ref, overrides);
  return "observed";
}

export async function continueTaskRunOfConversation(
  db: Db,
  p: { tenant_id: string; conversation_id: string; now: Date },
  overrides: Partial<TaskServiceDeps> = {},
): Promise<TaskRunAdvance> {
  const [run] = await db
    .select({ id: taskRuns.id })
    .from(taskRuns)
    .where(
      and(eq(taskRuns.tenant_id, p.tenant_id), eq(taskRuns.conversation_id, p.conversation_id)),
    )
    .limit(1);
  if (!run) return "idle";
  return advanceTaskRun(db, { tenant_id: p.tenant_id, task_run_id: run.id, now: p.now }, overrides);
}

export async function settleTaskRunResultConfirmation(
  db: Db,
  p: { tenant_id: string; task_run_id: string; principal: ResolvedPrincipal; confirmed: boolean },
): Promise<boolean> {
  try {
    const loaded = await loadTaskRun(db, p.tenant_id, p.task_run_id);
    const conversation_id = loaded?.run.conversation_id;
    if (!loaded || !conversation_id) return false;
    const [pending] = await db
      .select({ id: conversationElicitations.id })
      .from(conversationElicitations)
      .where(
        and(
          eq(conversationElicitations.tenant_id, p.tenant_id),
          eq(conversationElicitations.conversation_id, conversation_id),
          eq(conversationElicitations.status, "pending"),
          eq(conversationElicitations.tool_name, "ask_user_confirm"),
          sql`${conversationElicitations.input}->>'question' = ${loaded.task.goal}`,
          sql`${conversationElicitations.input}->'commit_intent' IS NULL`,
        ),
      )
      .orderBy(desc(conversationElicitations.created_at))
      .limit(1);
    if (!pending) return false;
    const answered = await answerElicitationAsPerson(db, {
      tenant_id: p.tenant_id,
      conversation_id,
      elicitation_id: pending.id,
      principal: p.principal,
      output: { confirmed: p.confirmed },
    });
    if (answered && p.confirmed) {
      const scope = { tenant_id: p.tenant_id, conversation_id };
      const plan = await readConversationPlaybookPlan(db, scope);
      const view = await readPlaybook(db, { ...scope, principal: p.principal });
      if (plan && view)
        await updatePlaybook(
          db,
          { ...scope, principal: p.principal },
          { expected_revision: view.revision, plan },
        );
    }
    return answered;
  } catch (error) {
    logger.warn({
      module: "tasks",
      action: "task_run.result_confirmation_not_settled",
      msg: "the result decision was recorded on the run, but the open question in the conversation was not answered",
      tenant_id: p.tenant_id,
      task_run_id: p.task_run_id,
      ...errorFields(error),
    });
    return false;
  }
}
