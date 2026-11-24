import { and, eq, inArray, sql } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import { z } from "zod";
import {
  appendUserMessage,
  describeTurnFailure,
  isExpectedCancellation,
  MODEL_RELAYED_ANSWER,
  runConversationTurn,
  TASK_RUN_CONTINUATION_ORIGIN,
} from "../../conversations/public/authoring.ts";
import {
  clearConversationTurnFailure,
  conversationTurnId,
  onConversationTurnReleased,
  recordConversationTurnFailure,
  registerConversationAbort,
  unregisterConversationAbort,
} from "../../conversations/public/lifecycle.ts";
import { ConversationTurnInProgressError } from "../../conversations/types.ts";
import type { Db } from "../../db/client.ts";
import { conversationTurns, taskRuns } from "../../db/schema/index.ts";
import {
  authorizationContextFromPrincipal,
  rehydrateExecutionPrincipal,
} from "../../execution/authorization-context.ts";
import { callerFromPrincipal } from "../../execution/caller-context.ts";
import { errorFields, log, logger } from "../../logging/index.ts";
import { can } from "../../rbac/evaluator.ts";
import type { TaskServiceDeps } from "../../tasks/index.ts";
import type { LoadedTaskRun, TaskRunTurnFacts } from "../../tasks/run-driver.ts";
import { getBoss } from "../boss.ts";
import {
  enqueueHostedWork,
  HostedWorkQuotaError,
  hostedQueueGroupConcurrency,
  queueWorkerConcurrency,
  withHostedWork,
} from "../hosted-work.ts";
import { withActiveTenantJobContext } from "../job-context.ts";
import { TASK_RUN_TURN_QUEUE } from "../queues.ts";
import { queuedSendTransaction } from "../transaction-adapter.ts";

export const TaskRunTurnJobSchema = z
  .object({ tenant_id: z.uuid(), task_id: z.uuid(), task_run_id: z.uuid() })
  .strict();

export type TaskRunTurnJob = z.infer<typeof TaskRunTurnJobSchema>;

export interface TaskRunTurnHandlerDeps {
  runTurn: typeof runConversationTurn;
  now: () => Date;
  service: Partial<TaskServiceDeps>;
}

interface RegisterTaskRunTurnOptions {
  boss: PgBoss;
  db: Db;
  deps?: Partial<TaskRunTurnHandlerDeps>;
}

const UNSETTLED_JOB_STATES = ["created", "retry", "active"];
const MAPPED_TURN_FAILURES = new Set([
  "llm_spend_limit_reached",
  "ai_access_missing",
  "llm_provider_limited",
  "llm_provider_quota_exhausted",
]);
const TURN_LISTENER = "task_runs";

let activeBoss: PgBoss | null = null;

function singletonKey(task_run_id: string): string {
  return `task-run:${task_run_id}`;
}

function handlerDeps(overrides: Partial<TaskRunTurnHandlerDeps> = {}): TaskRunTurnHandlerDeps {
  return { runTurn: runConversationTurn, now: () => new Date(), service: {}, ...overrides };
}

function dropped(job: Job<TaskRunTurnJob>, msg: string): void {
  log.queue.job.completed({
    msg,
    queue: TASK_RUN_TURN_QUEUE,
    job_id: job.id,
    tenant_id: job.data.tenant_id,
    task_run_id: job.data.task_run_id,
  });
}

export async function enqueueTaskRunTurn(
  db: Db,
  payload: TaskRunTurnJob,
  options: { boss?: PgBoss; except_job_id?: string } = {},
): Promise<string | null> {
  const boss = options.boss ?? activeBoss ?? getBoss();
  const job: TaskRunTurnJob = {
    tenant_id: payload.tenant_id,
    task_id: payload.task_id,
    task_run_id: payload.task_run_id,
  };
  return await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`task-run-turn:${job.task_run_id}`}, 0))`,
    );
    const [run] = await tx
      .select({ state: taskRuns.state, conversation_id: taskRuns.conversation_id })
      .from(taskRuns)
      .where(and(eq(taskRuns.tenant_id, job.tenant_id), eq(taskRuns.id, job.task_run_id)))
      .limit(1);
    if (run?.state !== "running" || !run.conversation_id) return null;
    const jobs = await boss.findJobs(TASK_RUN_TURN_QUEUE, { key: singletonKey(job.task_run_id) });
    if (
      jobs.some(
        (queued) =>
          queued.id !== options.except_job_id && UNSETTLED_JOB_STATES.includes(queued.state),
      )
    )
      return null;
    const [held] = await tx
      .select({ id: conversationTurns.id })
      .from(conversationTurns)
      .where(
        and(
          eq(conversationTurns.tenant_id, job.tenant_id),
          eq(conversationTurns.conversation_id, run.conversation_id),
          inArray(conversationTurns.state, ["queued", "running", "parked"]),
        ),
      )
      .limit(1);
    if (held) return null;
    try {
      return await enqueueHostedWork(tx as Db, boss, "chat", TASK_RUN_TURN_QUEUE, job, {
        singletonKey: singletonKey(job.task_run_id),
        db: queuedSendTransaction(tx),
      });
    } catch (error) {
      if (!(error instanceof HostedWorkQuotaError)) throw error;
      logger.info({
        module: "queue",
        action: "task_run_turn.deferred",
        msg: "the workspace has no room for another queued turn; the next sweep tries again",
        tenant_id: job.tenant_id,
        task_run_id: job.task_run_id,
      });
      return null;
    }
  });
}

async function driveTurn(
  job: Job<TaskRunTurnJob>,
  db: Db,
  boss: PgBoss,
  deps: TaskRunTurnHandlerDeps,
  loaded: LoadedTaskRun,
): Promise<void> {
  const data = job.data;
  const { run, task } = loaded;
  const conversation_id = run.conversation_id as string;
  const tasksApi = await import("../../tasks/index.ts");
  const driver = await import("../../tasks/run-driver.ts");
  const service = tasksApi.taskServiceDeps(deps.service);
  const scope = { tenant_id: data.tenant_id, task_run_id: run.id };
  const observe = (turn: TaskRunTurnFacts) =>
    driver.observeTaskRun(db, { ...scope, turn, source: "queue" }, deps.service);
  const idle = (failure: TaskRunTurnFacts["failure"] = null): TaskRunTurnFacts => ({
    id: null,
    driver: "task",
    failure,
    interrupted: false,
  });

  if (tasksApi.taskRunLimitReached(run, { max_turns: task.max_turns }, deps.now())) {
    await observe(idle());
    return dropped(job, "task.run-turn reached its limit — run state updated");
  }
  const owner = await service.loadOwner(db, data.tenant_id, task.owner_id);
  const stored = tasksApi.taskRunPrincipal(task, owner, run);
  const permitted =
    owner.active &&
    (await can(db, { tenant_id: data.tenant_id, principal: stored, permission: "task:run" })).allow;
  if (!permitted) {
    await tasksApi.abortTaskRun(
      {
        tenant_id: data.tenant_id,
        principal: tasksApi.SYSTEM_SCOPE,
        task_run_id: run.id,
        system_reason: "owner_unavailable",
      },
      db,
      deps.service,
    );
    return dropped(job, "task.run-turn owner may not run tasks — run ended");
  }
  if (!(await service.aiAccessConfigured(db, data.tenant_id))) {
    await observe(idle({ code: "ai_access_missing", retry_at: null }));
    return dropped(job, "task.run-turn has no AI access — run waits");
  }
  const facts = await driver.buildTaskRunObservation(db, loaded, idle(), deps.service);
  if (
    facts.conversation_status === "missing" ||
    facts.conversation_status === "abandoned" ||
    facts.pending_elicitation !== null
  ) {
    await tasksApi.recordRunObservation(
      { ...scope, observation: facts, source: "queue" },
      db,
      deps.service,
    );
    return dropped(job, "task.run-turn found nothing to continue — run state updated");
  }

  let principal: Awaited<ReturnType<typeof rehydrateExecutionPrincipal>>;
  try {
    principal = await rehydrateExecutionPrincipal(
      db,
      callerFromPrincipal(stored, data.tenant_id, stored.product_id),
      authorizationContextFromPrincipal(stored),
    );
  } catch (error) {
    if ((error as { code?: string }).code !== "execution_authentication_unavailable") throw error;
    principal = null;
  }
  if (!principal) {
    const settled = await observe(idle());
    if (settled?.run.state === "running")
      await tasksApi.abortTaskRun(
        { tenant_id: data.tenant_id, principal: tasksApi.SYSTEM_SCOPE, task_run_id: run.id },
        db,
        deps.service,
      );
    return dropped(job, "task.run-turn authority is no longer valid — run stopped");
  }

  let ctrl: AbortController;
  try {
    ctrl = await registerConversationAbort(data.tenant_id, conversation_id, db);
  } catch (error) {
    if (!(error instanceof ConversationTurnInProgressError)) throw error;
    return dropped(job, "task.run-turn found the conversation busy — dropped");
  }
  const current = await driver.loadTaskRun(db, data.tenant_id, run.id);
  if (current?.run.state !== "running" || ctrl.signal.aborted) {
    await unregisterConversationAbort(data.tenant_id, conversation_id, ctrl, "cancelled");
    return dropped(job, "task.run-turn stopped before starting its turn — dropped");
  }
  const turn_id = conversationTurnId(ctrl) ?? null;
  if (turn_id) driver.markTaskDrivenTurn(turn_id, true);
  const asked = await driver
    .buildTaskRunObservation(db, loaded, idle(), deps.service)
    .then((fresh) => (fresh.pending_elicitation === null ? null : fresh))
    .catch(() => null);
  if (asked) {
    await unregisterConversationAbort(data.tenant_id, conversation_id, ctrl);
    if (turn_id) driver.markTaskDrivenTurn(turn_id, false);
    await tasksApi.recordRunObservation(
      { ...scope, observation: asked, source: "queue" },
      db,
      deps.service,
    );
    return dropped(job, "task.run-turn found a question asked meanwhile — run waits");
  }
  let failure: TaskRunTurnFacts["failure"] = null;
  let result: Awaited<ReturnType<typeof observe>> = null;
  try {
    try {
      await clearConversationTurnFailure(db, data.tenant_id, conversation_id);
      const appended = await appendUserMessage(
        {
          ...(turn_id ? { turn_id } : {}),
          tenant_id: data.tenant_id,
          conversation_id,
          actor_id: task.owner_id,
          principal,
          message: driver.taskRunTurnPrompt(task.locale, driver.taskRunTurnKind(run)),
          origin: TASK_RUN_CONTINUATION_ORIGIN,
        },
        db,
      );
      await deps.runTurn(
        {
          tenant_id: data.tenant_id,
          conversation_id,
          actor_id: task.owner_id,
          principal,
          user_message: appended.message,
          answer_actor: MODEL_RELAYED_ANSWER,
          locale: task.locale,
          surface: "web",
          turn_abort_ctrl: ctrl,
        },
        db,
      );
    } catch (error) {
      if (isExpectedCancellation(error, ctrl.signal)) {
        failure = { code: tasksApi.TASK_TURN_STOPPED, retry_at: null };
      } else {
        const described = describeTurnFailure(error);
        failure = driver.taskRunTurnFailure(described, deps.now());
        if (described.code === "llm_spend_limit_reached")
          await driver.recordBudgetWait(db, {
            ...scope,
            projected_tokens: driver.refusedTurnTokens(error),
          });
        if (!MAPPED_TURN_FAILURES.has(described.code))
          await recordConversationTurnFailure(db, data.tenant_id, conversation_id, described);
        logger.warn({
          module: "queue",
          action: "task_run_turn.turn_failed",
          msg: "a background task turn failed; the run state follows the failure",
          tenant_id: data.tenant_id,
          task_run_id: run.id,
          failure_code: described.code,
        });
      }
    }
    result = await observe({ id: turn_id, driver: "task", failure, interrupted: false });
  } finally {
    await unregisterConversationAbort(
      data.tenant_id,
      conversation_id,
      ctrl,
      failure ? "failed" : "completed",
    ).catch(() => undefined);
    if (turn_id) driver.markTaskDrivenTurn(turn_id, false);
  }
  if (result?.enqueue) {
    try {
      if (deps.service.enqueueRunTurn) await deps.service.enqueueRunTurn(db, data);
      else await enqueueTaskRunTurn(db, data, { boss, except_job_id: job.id });
    } catch (error) {
      logger.warn({
        module: "queue",
        action: "task_run_turn.next_turn_not_queued",
        msg: "the turn is recorded, but the next one was not queued; the sweep continues the run",
        tenant_id: data.tenant_id,
        task_run_id: run.id,
        ...errorFields(error),
      });
    }
  }
  log.queue.job.completed({
    msg: "task.run-turn job completed",
    queue: TASK_RUN_TURN_QUEUE,
    job_id: job.id,
    tenant_id: data.tenant_id,
    task_run_id: run.id,
    run_state: result?.run.state,
  });
}

export async function handleTaskRunTurnJob(
  job: Job<TaskRunTurnJob>,
  db: Db,
  boss: PgBoss,
  overrides: Partial<TaskRunTurnHandlerDeps> = {},
): Promise<void> {
  const deps = handlerDeps(overrides);
  const parsed = TaskRunTurnJobSchema.safeParse(job.data);
  if (!parsed.success) {
    log.queue.job.failed({
      msg: "task.run-turn job has a malformed payload — dropped",
      queue: TASK_RUN_TURN_QUEUE,
      job_id: job.id,
      error: "task_run_turn_payload_invalid",
    });
    return;
  }
  await withActiveTenantJobContext(job.data, db, async () => {
    log.queue.job.dequeued({
      msg: "task.run-turn job dequeued",
      queue: TASK_RUN_TURN_QUEUE,
      job_id: job.id,
      tenant_id: job.data.tenant_id,
    });
    const driver = await import("../../tasks/run-driver.ts");
    const { withTaskRunTrace } = await import("../../tasks/trace.ts");
    const loaded = await driver.loadTaskRun(db, job.data.tenant_id, job.data.task_run_id);
    if (!loaded || loaded.run.task_id !== job.data.task_id || loaded.run.state !== "running")
      return dropped(job, "task.run-turn has no running run — dropped");
    if (!loaded.run.conversation_id) {
      await driver.observeTaskRun(
        db,
        {
          tenant_id: job.data.tenant_id,
          task_run_id: loaded.run.id,
          turn: { id: null, driver: "task", failure: null, interrupted: false },
          source: "queue",
        },
        deps.service,
      );
      return dropped(job, "task.run-turn lost its conversation — run failed");
    }
    try {
      await withTaskRunTrace(loaded.run, () =>
        withHostedWork(
          db,
          job.data.tenant_id,
          "chat",
          () => driveTurn(job, db, boss, deps, loaded),
          { queue: TASK_RUN_TURN_QUEUE, id: job.id },
        ),
      );
    } catch (error) {
      if (!(error instanceof HostedWorkQuotaError)) {
        log.queue.job.failed({
          msg: "task.run-turn job failed",
          queue: TASK_RUN_TURN_QUEUE,
          job_id: job.id,
          tenant_id: job.data.tenant_id,
          ...errorFields(error),
        });
        throw error;
      }
      dropped(job, "task.run-turn has no hosted capacity — the next sweep tries again");
    }
  });
}

export function registerTaskRunTurnListener(overrides: Partial<TaskServiceDeps> = {}): void {
  onConversationTurnReleased(TURN_LISTENER, async (release) => {
    const driver = await import("../../tasks/run-driver.ts");
    await driver.observePersonTurn(release, overrides);
  });
}

export function useTaskRunTurnBoss(boss: PgBoss | null): void {
  activeBoss = boss;
}

export async function registerTaskRunTurnHandler(
  opts: RegisterTaskRunTurnOptions,
): Promise<string> {
  const { boss, db } = opts;
  useTaskRunTurnBoss(boss);
  const workerId = await boss.work<TaskRunTurnJob>(
    TASK_RUN_TURN_QUEUE,
    {
      batchSize: 1,
      localConcurrency: queueWorkerConcurrency(),
      groupConcurrency: hostedQueueGroupConcurrency("chat"),
      pollingIntervalSeconds: 2,
    },
    async (jobs: Job<TaskRunTurnJob>[]) => {
      for (const job of jobs) await handleTaskRunTurnJob(job, db, boss, opts.deps);
    },
  );
  log.queue.worker.registered({ msg: "task.run-turn worker registered", worker_id: workerId });
  return workerId;
}
