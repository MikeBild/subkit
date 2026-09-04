// conversation.run-turn worker lifecycle (integration).
//
// Drives the GENUINE pg-boss worker end-to-end. Pins the SEP-1686
// background-turn contract:
//   - a `start` job runs the turn and writes the terminal envelope
//     into `mcp_tasks.result`,
//   - a job whose `mcp_tasks` row is already terminal is an idempotent
//     no-op (pg-boss at-least-once),
//   - turn_seq increments monotonically per conversation.

import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { getConfig, loadConfig } from "../../config/loader.ts";
import { createElicitation } from "../../conversations/elicitations.ts";
import * as svc from "../../conversations/service.ts";
import {
  auditLog,
  conversations,
  mcpTasks,
  tenantLlmSettings,
  tenants,
  users,
} from "../../db/schema/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import {
  getMcpTask,
  insertMcpTask,
  rearmMcpTaskForNativeElicitation,
  setMcpTaskCancelled,
  setMcpTaskFailure,
  setMcpTaskJobId,
  setMcpTaskParked,
  setMcpTaskResult,
  setMcpTaskResultIfCurrentAttempt,
} from "../../mcp/tasks/store.ts";
import { ConversationTaskStore } from "../../mcp/tasks/task-store.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { flush, waitFor } from "../../test-helpers/determinism/wait.ts";
import { createQueueCtx, type QueueTestCtx } from "../tests/setup.ts";
import {
  enqueueConversationRunTurn,
  registerConversationRunTurnHandler,
  SUPERSEDED_WHILE_PARKED_FAILURE_REASON,
} from "./conversation-run-turn.ts";

let queue: QueueTestCtx;
let tenantId: string;
let userId: string;

async function ensureConfig(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {
    // not loaded
  }
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-runturn-test-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/runturn-test", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

/** Poll an mcp_tasks row until it reaches a terminal state. */
async function waitForTerminal(taskId: string): Promise<void> {
  await waitFor(
    async () => {
      const row = await getMcpTask(tenantId, taskId, queue.testDb.db);
      return Boolean(row && (row.result || row.failure_reason || row.cancelled_at));
    },
    { tries: 120, sleepMs: 250, label: "mcp_task terminal state" },
  );
}

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  await ensureConfig();
  resetMockProvider();
  queue = await createQueueCtx("conversation_run_turn");
  const [t] = await queue.testDb.db
    .insert(tenants)
    .values({ slug: "t-runturn", display_name: "RunTurn" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  tenantId = t.id;
  const [u] = await queue.testDb.db
    .insert(users)
    .values({ tenant_id: tenantId, email: "rt@test.local", role: "admin" })
    .returning();
  if (!u) throw new Error("seed user failed");
  userId = u.id;
  // Explicit mock model names so the failure-path test can fail both
  // the primary and the fallback model deterministically.
  await queue.testDb.db.insert(tenantLlmSettings).values({
    tenant_id: tenantId,
    llm_provider: "mock",
    llm_primary_model: "runturn-primary",
    llm_fallback_model: "runturn-fallback",
  });
  await registerConversationRunTurnHandler({ boss: queue.boss, db: queue.testDb.db });
});

afterAll(async () => {
  await queue.cleanup();
});

async function seedConversationAndTask(
  message: string,
): Promise<{ conversation_id: string; mcp_task_id: string }> {
  const created = await svc.createConversation(
    { tenant_id: tenantId, actor_id: userId, initial_message: message },
    queue.testDb.db,
  );
  const taskId = await insertMcpTask(
    {
      tenant_id: tenantId,
      conversation_id: created.conversation.id,
      kind: "start",
      actor_id: userId,
      request_source: "mcp",
      // Pin the turn to the persisted first user message — the worker
      // reads THAT row by id, never the most-recent one.
      user_message_id: created.initial_message_id,
    },
    queue.testDb.db,
  );
  return { conversation_id: created.conversation.id, mcp_task_id: taskId };
}

describe("conversation.run-turn worker", () => {
  test("a start job runs the turn and writes the terminal envelope into mcp_tasks.result", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("list users");
    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    });
    await waitForTerminal(mcp_task_id);
    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.result).toBeTruthy();
    expect(row?.result?.conversation_id).toBe(conversation_id);
    expect(row?.failure_reason).toBeNull();
  }, 45_000);

  test("a job whose mcp_tasks row is already terminal is an idempotent no-op", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("list users");
    // Pre-seed a terminal result — the worker entry guard must skip.
    await setMcpTaskResult(
      tenantId,
      mcp_task_id,
      { conversation_id, status: "active", events: [{ marker: "pre-seeded" }] },
      queue.testDb.db,
    );
    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    });
    // Give the worker time to dequeue + early-return, then assert the
    // pre-seeded result was not overwritten. A few real-time polls span
    // the worker's 2s polling interval without a bare wall-clock sleep.
    for (let i = 0; i < 12; i++) await flush();
    await waitFor(async () => true, { tries: 8, sleepMs: 250, label: "worker dequeue window" });
    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    // The pre-seeded marker survived — the worker did NOT overwrite it.
    const events = (row?.result?.events ?? []) as Array<{ marker?: string }>;
    expect(events[0]?.marker).toBe("pre-seeded");
  }, 20_000);

  test("turn_seq increments monotonically per conversation", async () => {
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "hello" },
      queue.testDb.db,
    );
    const first = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        kind: "start",
        actor_id: userId,
        request_source: "mcp",
        user_message_id: created.initial_message_id,
      },
      queue.testDb.db,
    );
    const second = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        kind: "append",
        actor_id: userId,
        request_source: "mcp",
        user_message_id: null,
      },
      queue.testDb.db,
    );
    const [r1] = await queue.testDb.db
      .select({ turn_seq: mcpTasks.turn_seq })
      .from(mcpTasks)
      .where(eq(mcpTasks.id, first));
    const [r2] = await queue.testDb.db
      .select({ turn_seq: mcpTasks.turn_seq })
      .from(mcpTasks)
      .where(eq(mcpTasks.id, second));
    expect(r1?.turn_seq).toBe(1);
    expect(r2?.turn_seq).toBe(2);
  });

  test("a pausing attempt cannot overwrite the native-resume attempt on a reused task id", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("resume fence");
    const pausingAttempt = "00000000-0000-4000-8000-000000000101";
    const resumedAttempt = "00000000-0000-4000-8000-000000000102";
    await setMcpTaskJobId(tenantId, mcp_task_id, pausingAttempt, queue.testDb.db);

    // Native MCP Tasks keep one public task id across input_required. Rearming
    // clears the paused result, then the resume owns a new queue attempt.
    expect(
      await rearmMcpTaskForNativeElicitation(
        { tenant_id: tenantId, task_id: mcp_task_id, actor_id: userId },
        queue.testDb.db,
      ),
    ).toBe(true);
    await setMcpTaskJobId(tenantId, mcp_task_id, resumedAttempt, queue.testDb.db);

    // The old worker can finish unwinding after the rearm. Its stale result is
    // rejected, while the current resume can publish normally.
    expect(
      await setMcpTaskResultIfCurrentAttempt(
        tenantId,
        mcp_task_id,
        pausingAttempt,
        { conversation_id, status: "awaiting_input", events: [{ marker: "stale" }] },
        queue.testDb.db,
      ),
    ).toBe(false);
    expect(
      await setMcpTaskResultIfCurrentAttempt(
        tenantId,
        mcp_task_id,
        resumedAttempt,
        { conversation_id, status: "active", events: [{ marker: "resumed" }] },
        queue.testDb.db,
      ),
    ).toBe(true);

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.job_id).toBe(resumedAttempt);
    expect((row?.result?.events as Array<{ marker?: string }> | undefined)?.[0]?.marker).toBe(
      "resumed",
    );
  });
});

describe("conversation.run-turn worker — failure path", () => {
  test("a turn that throws writes failure_reason and emits a CONVERSATION_TURN_FAILED audit row", async () => {
    // Both the primary and the fallback model fail — the conversation
    // loop exhausts its fallback and rethrows the provider error out of
    // `runConversationTurn`. The worker catch must (a) stamp
    // failure_reason, (b) write the audit row, (c) re-throw for the DLQ.
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "fail me" },
      queue.testDb.db,
    );
    const conversation_id = created.conversation.id;
    const mcp_task_id = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id,
        kind: "start",
        actor_id: userId,
        request_source: "mcp",
        user_message_id: created.initial_message_id,
      },
      queue.testDb.db,
    );
    getMockProvider().setFailure("runturn-primary", "overloaded");
    getMockProvider().setFailure("runturn-fallback", "overloaded");

    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    });
    await waitFor(
      async () => {
        const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
        return Boolean(row?.failure_reason);
      },
      { tries: 80, sleepMs: 250, label: "mcp_task failure_reason" },
    );

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.failure_reason).toContain("overloaded");
    expect(row?.result).toBeNull();

    // The task derives `failed`.
    const store = new ConversationTaskStore({ db: queue.testDb.db, tenant_id: tenantId });
    const task = await store.getTask(mcp_task_id);
    expect(task?.status).toBe("failed");
    expect(task?.statusMessage).toContain("overloaded");

    // A CONVERSATION_TURN_FAILED audit row was written with the failure
    // reason + the mcp_task correlation id.
    //
    // Waited for on its own terms rather than inherited from the
    // failure_reason wait above: the handler stamps failure_reason FIRST and
    // writes this row afterwards, so a test that wakes on the stamp and reads
    // the audit table immediately is racing a window it did not measure. It
    // holds on an idle machine and loses under load, which is the shape of a
    // flake that only ever fails in CI.
    const auditRows = async () =>
      await queue.testDb.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.tenant_id, tenantId),
            eq(auditLog.action, "conversation.turn_failed"),
            eq(auditLog.resource_id, conversation_id),
          ),
        );
    await waitFor(async () => (await auditRows()).length > 0, {
      tries: 80,
      sleepMs: 250,
      label: "conversation.turn_failed audit row",
    });
    const audits = await auditRows();
    expect(audits).toHaveLength(1);
    expect(audits[0]?.result).toBe("error");
    expect(audits[0]?.reason).toContain("overloaded");
    expect((audits[0]!.metadata as { mcp_task_id?: string }).mcp_task_id).toBe(mcp_task_id);
  }, 45_000);

  test("a provider quota error parks the turn instead of failing it — no failure_reason, job re-enqueued with startAfter", async () => {
    // Both models refuse with a quota error (the fallback is quota-limited
    // too). The worker must NOT stamp failure_reason / emit a failure audit
    // row — the turn is re-enqueued with `provider_limit_parks:1` and a
    // `startAfter` in the future, so the task keeps deriving `working`
    // until the provider window resets.
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("quota me");
    getMockProvider().setFailure("runturn-primary", "quota_exhausted");
    getMockProvider().setFailure("runturn-fallback", "quota_exhausted");

    const sends: Array<{ data: unknown; options: unknown }> = [];
    const originalSend = queue.boss.send.bind(queue.boss);
    const spy = spyOn(queue.boss, "send").mockImplementation((async (
      name: string,
      data: object,
      options?: object,
    ) => {
      // Record park re-enqueues but do NOT deliver them — the parked job
      // would otherwise sit in pg-boss with a 15-minute startAfter anyway.
      if ((data as { provider_limit_parks?: number }).provider_limit_parks) {
        sends.push({ data, options });
        // Mirror pg-boss' successful preassigned-id response without making
        // the scheduled job visible to this test worker.
        return (options as { id?: string } | undefined)?.id ?? null;
      }
      return await originalSend(name, data, options);
    }) as typeof queue.boss.send);
    try {
      await enqueueConversationRunTurn(queue.boss, {
        tenant_id: tenantId,
        conversation_id,
        mcp_task_id,
        actor_id: userId,
        kind: "start",
      });
      await waitFor(async () => sends.length > 0, {
        tries: 120,
        sleepMs: 250,
        label: "provider-limit park re-enqueue",
      });
    } finally {
      spy.mockRestore();
    }

    const send = sends[0]!;
    const parkedData = send.data as { provider_limit_parks?: number; mcp_task_id?: string };
    expect(parkedData.provider_limit_parks).toBe(1);
    expect(parkedData.mcp_task_id).toBe(mcp_task_id);
    const startAfter = (send.options as { startAfter?: Date }).startAfter;
    expect(startAfter).toBeInstanceOf(Date);
    expect(startAfter!.getTime()).toBeGreaterThan(getTestNow());

    // The task is NOT terminal: no failure, no result — still `working`.
    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.failure_reason).toBeNull();
    expect(row?.result).toBeNull();
    const store = new ConversationTaskStore({ db: queue.testDb.db, tenant_id: tenantId });
    expect((await store.getTask(mcp_task_id))?.status).toBe("working");

    // No CONVERSATION_TURN_FAILED audit row was emitted for the park.
    const audits = await queue.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "conversation.turn_failed"),
          eq(auditLog.resource_id, conversation_id),
        ),
      );
    expect(audits).toHaveLength(0);
  }, 45_000);

  test("a job whose mcp_tasks row already has failure_reason is an idempotent no-op", async () => {
    // pg-boss is at-least-once. A redelivery of a job that already
    // failed must NOT re-run the turn and must NOT write a second audit
    // row — the worker entry guard treats failure_reason as terminal.
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("idempotent fail");
    await setMcpTaskFailure(tenantId, mcp_task_id, "pre_seeded_failure", queue.testDb.db);

    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    });
    for (let i = 0; i < 12; i++) await flush();
    await waitFor(async () => true, { tries: 8, sleepMs: 250, label: "worker dequeue window" });

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    // The pre-seeded reason survived — the worker did not overwrite it.
    expect(row?.failure_reason).toBe("pre_seeded_failure");
    // No CONVERSATION_TURN_FAILED audit row was emitted by the no-op.
    const audits = await queue.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "conversation.turn_failed"),
          eq(auditLog.resource_id, conversation_id),
        ),
      );
    expect(audits).toHaveLength(0);
  }, 20_000);
});

describe("conversation.run-turn worker — cancel", () => {
  test("a job whose mcp_tasks row already has cancelled_at is an idempotent no-op", async () => {
    // `tasks/cancel` may land before the worker dequeues the job. The
    // worker entry guard treats cancelled_at as terminal and skips the
    // turn entirely — no result, no failure.
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("cancel before start");
    await setMcpTaskCancelled(tenantId, mcp_task_id, queue.testDb.db);

    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    });
    for (let i = 0; i < 12; i++) await flush();
    await waitFor(async () => true, { tries: 8, sleepMs: 250, label: "worker dequeue window" });

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.cancelled_at).toBeInstanceOf(Date);
    // The cancelled task never produced a result and never failed.
    expect(row?.result).toBeNull();
    expect(row?.failure_reason).toBeNull();

    const store = new ConversationTaskStore({ db: queue.testDb.db, tenant_id: tenantId });
    const task = await store.getTask(mcp_task_id);
    expect(task?.status).toBe("cancelled");
  }, 20_000);
});

describe("conversation.run-turn worker — elicitation pause", () => {
  test("a turn that pauses on ask_user_* finishes the job but the task derives input_required", async () => {
    // A backgrounded turn passes NO elicitationBridge, so an
    // ask_user_confirm takes the DB-pause path: the turn FINISHES
    // (result is written) while the conversation is left awaiting_input
    // with a pending elicitation. The task derivation must surface
    // `input_required`, NOT `completed`.
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "list users from the api" },
      queue.testDb.db,
    );
    const conversation_id = created.conversation.id;
    // A canned plan that walks to an ask_user_confirm and pauses there.
    getMockProvider().setConversePlan(conversation_id, [
      {
        tool: "ask_user_confirm",
        args: { question: "Proceed?", kind: "generic", summary: "confirm proceed" },
      },
    ]);
    const mcp_task_id = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id,
        kind: "start",
        actor_id: userId,
        request_source: "mcp",
        user_message_id: created.initial_message_id,
      },
      queue.testDb.db,
    );
    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    });
    await waitForTerminal(mcp_task_id);

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    // The worker wrote a result envelope — the turn itself finished.
    expect(row?.result).toBeTruthy();
    expect(row?.failure_reason).toBeNull();
    // But the conversation is parked at awaiting_input.
    const [conv] = await queue.testDb.db
      .select({ status: conversations.status })
      .from(conversations)
      .where(eq(conversations.id, conversation_id));
    expect(conv?.status).toBe("awaiting_input");
    // Derivation: input_required wins over completed.
    const store = new ConversationTaskStore({ db: queue.testDb.db, tenant_id: tenantId });
    const task = await store.getTask(mcp_task_id);
    expect(task?.status).toBe("input_required");
  }, 45_000);
});

describe("conversation.run-turn worker — cancel in the guard window", () => {
  test("a cancel landing in the guard window still stops the turn — no result written", async () => {
    // The cancel can land between the worker's entry guard and the
    // `registerConversationAbort` call: it stamps `cancelled_at` AND
    // calls `cancelConversationAbort` against a controller that does
    // not exist yet, so the abort is lost. The worker re-reads the
    // `mcp_tasks` row right after registering — `cancelled_at` is now
    // set, so the turn must not run to completion. This test stamps
    // `cancelled_at` before enqueue (so it is observable on the row)
    // and asserts the worker bails: the system-level invariant is
    // "a cancelled task never produces a `result`", which the entry
    // guard + the S1 re-check together guarantee.
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "list users" },
      queue.testDb.db,
    );
    const conversation_id = created.conversation.id;
    const mcp_task_id = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id,
        kind: "start",
        actor_id: userId,
        request_source: "mcp",
        user_message_id: created.initial_message_id,
      },
      queue.testDb.db,
    );
    // The cancel: stamp the terminal marker and fire the (lost) abort
    // against a not-yet-registered controller — exactly the guard
    // window the S1 re-check closes.
    const store = new ConversationTaskStore({ db: queue.testDb.db, tenant_id: tenantId });
    await store.updateTaskStatus(mcp_task_id, "cancelled");

    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    });
    for (let i = 0; i < 12; i++) await flush();
    await waitFor(async () => true, { tries: 12, sleepMs: 250, label: "worker dequeue window" });

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.cancelled_at).toBeInstanceOf(Date);
    // The turn did NOT run to completion — no result, no failure.
    expect(row?.result).toBeNull();
    expect(row?.failure_reason).toBeNull();
    expect((await store.getTask(mcp_task_id))?.status).toBe("cancelled");
  }, 30_000);
});

describe("conversation.run-turn worker — respond_elicitation surface threading", () => {
  test("the respond branch passes surface:'mcp' into respondElicitation", async () => {
    // The resumed runLoop must know it runs on the MCP surface — the
    // inner confirm gate collapses enumerated writes there instead of
    // pausing on approvals no human can reach. Capture the params the
    // worker hands to `respondElicitation` and pin the surface.
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "respond surface seed" },
      queue.testDb.db,
    );
    const conversation_id = created.conversation.id;
    const elicitation = await createElicitation(
      {
        tenant_id: tenantId,
        conversation_id,
        tool_call_id: null,
        tool_name: "ask_user_text",
        summary: "surface probe",
        input: { question: "probe?" },
        actor_id: userId,
      },
      queue.testDb.db,
    );
    const mcp_task_id = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id,
        kind: "respond_elicitation",
        actor_id: userId,
        request_source: "mcp",
        user_message_id: null,
      },
      queue.testDb.db,
    );

    const captured: svc.RespondElicitationParams[] = [];
    const spy = spyOn(svc, "respondElicitation").mockImplementation(async (p) => {
      captured.push(p);
      return {
        conversation: created.conversation,
        result: { events: [], status: "active" as const },
      };
    });
    try {
      await enqueueConversationRunTurn(queue.boss, {
        tenant_id: tenantId,
        conversation_id,
        mcp_task_id,
        actor_id: userId,
        kind: "respond_elicitation",
        elicitation_id: elicitation.id,
      });
      await waitForTerminal(mcp_task_id);
    } finally {
      spy.mockRestore();
    }

    expect(captured).toHaveLength(1);
    expect(captured[0]?.surface).toBe("mcp");
    expect(captured[0]?.elicitation_id).toBe(elicitation.id);
    expect(captured[0]?.conversation_id).toBe(conversation_id);
  }, 30_000);

  test("mcp_native provenance becomes a human in-band answer and cannot come from tool args", async () => {
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "native answer seed" },
      queue.testDb.db,
    );
    const conversation_id = created.conversation.id;
    const elicitation = await createElicitation(
      {
        tenant_id: tenantId,
        conversation_id,
        tool_call_id: null,
        tool_name: "ask_user_confirm",
        summary: "approve native action",
        input: { question: "Approve?" },
        actor_id: userId,
      },
      queue.testDb.db,
    );
    const mcp_task_id = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id,
        kind: "respond_elicitation",
        actor_id: userId,
        request_source: "mcp",
        user_message_id: null,
      },
      queue.testDb.db,
    );
    const principal = {
      kind: "user" as const,
      id: userId,
      tenant_id: tenantId,
      provider: "api_key" as const,
      roles: ["admin"],
    };
    const captured: svc.RespondElicitationParams[] = [];
    const spy = spyOn(svc, "respondElicitation").mockImplementation(async (p) => {
      captured.push(p);
      return {
        conversation: created.conversation,
        result: { events: [], status: "active" as const },
      };
    });
    try {
      await enqueueConversationRunTurn(queue.boss, {
        tenant_id: tenantId,
        conversation_id,
        mcp_task_id,
        actor_id: userId,
        principal,
        kind: "respond_elicitation",
        elicitation_id: elicitation.id,
        answer_channel: "mcp_native",
      });
      await waitForTerminal(mcp_task_id);
    } finally {
      spy.mockRestore();
    }
    expect(captured[0]?.answer_actor).toEqual({
      kind: "human",
      user_id: userId,
      via: "in_band_elicitation",
    });
  }, 30_000);
});

describe("conversation.run-turn worker — concurrent turns (B2)", () => {
  test("two concurrent appends each run their OWN pinned message — neither is dropped", async () => {
    // Two `conversation_append`s race on one conversation. Before the
    // fix the worker picked the most-recent `user` row by MAX(created_at)
    // — both workers would run the SAME (latest) message and the other
    // turn's message was silently dropped. With `user_message_id`
    // pinned on each `mcp_tasks` row the worker runs the EXACT message
    // its task captured.
    //
    // The initial message is a non-canned phrase so no mock plan is
    // seeded — `createConversation` leaves the conversation `active`
    // and the append turns run a plain text-only turn that completes
    // without parking at an elicitation.
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "concurrent turn seed" },
      queue.testDb.db,
    );
    const conversation_id = created.conversation.id;
    // Empty plan → the mock provider emits a text-only turn and the
    // turn completes `active` (no tool calls, no elicitation pause).
    getMockProvider().setConversePlan(conversation_id, []);

    // Two appends BEFORE either turn runs — distinct messages, distinct
    // persisted row ids. The conversation is `active`, so neither append
    // is refused on a pending elicitation.
    const appendA = await svc.appendUserMessage(
      { tenant_id: tenantId, conversation_id, actor_id: userId, message: "MESSAGE-ALPHA" },
      queue.testDb.db,
    );
    const appendB = await svc.appendUserMessage(
      { tenant_id: tenantId, conversation_id, actor_id: userId, message: "MESSAGE-BRAVO" },
      queue.testDb.db,
    );
    expect(appendA.message_id).not.toBe(appendB.message_id);

    const taskA = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id,
        kind: "append",
        actor_id: userId,
        request_source: "mcp",
        user_message_id: appendA.message_id,
      },
      queue.testDb.db,
    );
    const taskB = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id,
        kind: "append",
        actor_id: userId,
        request_source: "mcp",
        user_message_id: appendB.message_id,
      },
      queue.testDb.db,
    );
    // Enqueue both — the worker processes them serially but each must
    // run the message ITS task pinned.
    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id: taskA,
      actor_id: userId,
      kind: "append",
    });
    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id: taskB,
      actor_id: userId,
      kind: "append",
    });
    await waitForTerminal(taskA);
    await waitForTerminal(taskB);

    const rowA = await getMcpTask(tenantId, taskA, queue.testDb.db);
    const rowB = await getMcpTask(tenantId, taskB, queue.testDb.db);
    // Each turn's own user-message event carries the message ITS task
    // pinned — neither ran the other's message.
    const userTextOf = (row: typeof rowA): string | undefined => {
      const events = (row?.result?.events ?? []) as Array<{
        type?: string;
        role?: string;
        content?: { text?: string };
      }>;
      return events.find((e) => e.type === "message" && e.role === "user")?.content?.text;
    };
    expect(userTextOf(rowA)).toBe("MESSAGE-ALPHA");
    expect(userTextOf(rowB)).toBe("MESSAGE-BRAVO");
  }, 90_000);
});

describe("conversation.run-turn worker — parked turn supersession", () => {
  // ── Supersession of a parked turn ──────────────────────────────────
  //
  // A provider-limit park defers a turn for as long as the provider's
  // quota window — up to 45 days. The operator's natural response is to
  // retry, so the conversation can finish while an earlier turn is still
  // parked and runnable. These three pin the guard AND its boundaries:
  // it must fire on a superseded park, and must stay out of the way of
  // both a legitimate park resume and an ordinary queued turn.

  /** Complete a fresh, later turn on the same conversation. */
  async function completeLaterTurn(conversation_id: string): Promise<void> {
    const laterId = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id,
        kind: "append",
        actor_id: userId,
        request_source: "mcp",
        user_message_id: null,
      },
      queue.testDb.db,
    );
    await setMcpTaskResult(
      tenantId,
      laterId,
      { conversation_id, status: "active", events: [{ marker: "later-turn" }] },
      queue.testDb.db,
    );
  }

  test("a parked turn the conversation outran is not run — stamped superseded, the model is never called", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("outrun me");
    await setMcpTaskParked(
      tenantId,
      mcp_task_id,
      new Date(getTestNow() - 1_000),
      "provider_quota_exhausted",
      queue.testDb.db,
    );
    await completeLaterTurn(conversation_id);

    // Both models refuse: if the guard let the turn through, the run
    // would reach the provider and the task would end up parked again or
    // failed — either way NOT the superseded stamp asserted below.
    getMockProvider().setFailure("runturn-primary", "quota_exhausted");
    getMockProvider().setFailure("runturn-fallback", "quota_exhausted");
    try {
      await enqueueConversationRunTurn(queue.boss, {
        tenant_id: tenantId,
        conversation_id,
        mcp_task_id,
        actor_id: userId,
        kind: "start",
        provider_limit_parks: 1,
      });
      await waitForTerminal(mcp_task_id);
    } finally {
      resetMockProvider();
    }

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.failure_reason).toBe(SUPERSEDED_WHILE_PARKED_FAILURE_REASON);
    expect(row?.result).toBeNull();
    // The park stamp is left as it was: the turn never entered (a2).
    expect(row?.parked_reason).toBe("provider_quota_exhausted");
  }, 45_000);

  test("a parked turn with no later completed turn resumes normally", async () => {
    // The regression guard. A park whose conversation did NOT move on is
    // the case the whole park mechanism exists for — it must still run.
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("resume me");
    await setMcpTaskParked(
      tenantId,
      mcp_task_id,
      new Date(getTestNow() - 1_000),
      "provider_quota_exhausted",
      queue.testDb.db,
    );

    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
      provider_limit_parks: 1,
    });
    await waitForTerminal(mcp_task_id);

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.result).not.toBeNull();
    expect(row?.failure_reason).toBeNull();
    // (a2) ran, so the park stamp is gone.
    expect(row?.parked_until).toBeNull();
  }, 45_000);

  test("an unparked turn is never superseded, even with a later completed turn", async () => {
    // MCP turns are not serialized, so an ordinary queued turn may sit
    // behind a later one that finishes first. Discarding it would drop a
    // user message — the guard must not reach it.
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("queued behind");
    await completeLaterTurn(conversation_id);

    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    });
    await waitForTerminal(mcp_task_id);

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.result).not.toBeNull();
    expect(row?.failure_reason).toBeNull();
  }, 45_000);
});
