import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import { getConfig, loadConfig } from "../../config/loader.ts";
import { createElicitation } from "../../conversations/elicitations.ts";
import { _setConverseFirstChunkTimeoutMsForTests } from "../../conversations/loop.ts";
import * as svc from "../../conversations/service.ts";
import {
  auditLog,
  conversations,
  mcpTasks,
  sessions,
  systemAccounts,
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
import { builtinRoleId } from "../../rbac/roles.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { flush, waitFor } from "../../test-helpers/determinism/wait.ts";
import { createQueueCtx, type QueueTestCtx } from "../tests/setup.ts";
import {
  enqueueConversationRunTurn as enqueueRawConversationRunTurn,
  registerConversationRunTurnHandler,
  SUPERSEDED_WHILE_PARKED_FAILURE_REASON,
} from "./conversation-run-turn.ts";

let queue: QueueTestCtx;
let tenantId: string;
let userId: string;
let queuedPrincipal: ResolvedPrincipal;
const nextUuid = createDeterministicUuidFactory(0xc011a026);
function enqueueConversationRunTurn(
  boss: Parameters<typeof enqueueRawConversationRunTurn>[0],
  payload: Parameters<typeof enqueueRawConversationRunTurn>[2],
  options?: Parameters<typeof enqueueRawConversationRunTurn>[3],
) {
  const auth_source = payload.principal?.auth_source ?? queuedPrincipal.auth_source;
  if (!auth_source) throw new Error("queued fixture requires credential provenance");
  return enqueueRawConversationRunTurn(
    boss,
    queue.testDb.db,
    {
      ...payload,
      principal: {
        ...queuedPrincipal,
        ...payload.principal,
        auth_source,
      },
    },
    options,
  );
}

async function ensureConfig(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {}
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-runturn-test-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/runturn-test", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

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
    .values({
      tenant_id: tenantId,
      email: "rt@test.local",
      role_id: await builtinRoleId(queue.testDb.db, "admin"),
    })
    .returning();
  if (!u) throw new Error("seed user failed");
  userId = u.id;
  const [session] = await queue.testDb.db
    .insert(sessions)
    .values({
      tenant_id: tenantId,
      user_id: userId,
      expires_at: sql`clock_timestamp() + interval '1 hour'`,
    })
    .returning();
  if (!session) throw new Error("seed session failed");
  queuedPrincipal = {
    provider: "test",
    kind: "user",
    id: userId,
    tenant_id: tenantId,
    roles: ["admin"],
    auth_source: { kind: "browser_session", session_id: session.id },
  };
  await queue.testDb.db
    .update(tenants)
    .set({ llm_primary: "runturn-primary", llm_fallback: "runturn-fallback" })
    .where(eq(tenants.id, tenantId));
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
      actor: { kind: "user", id: userId },
      request_source: "mcp",
      user_message_id: created.initial_message_id,
    },
    queue.testDb.db,
  );
  return { conversation_id: created.conversation.id, mcp_task_id: taskId };
}

describe("conversation.run-turn worker", () => {
  test("missing queued principal uses the persisted task caller for audit attribution", async () => {
    const { conversation_id, mcp_task_id } =
      await seedConversationAndTask("deny missing principal");
    await enqueueRawConversationRunTurn(queue.boss, queue.testDb.db, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      principal: null,
      kind: "start",
    });
    await waitForTerminal(mcp_task_id);

    const denials = await queue.testDb.db
      .select({
        action: auditLog.action,
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
        reason: auditLog.reason,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          inArray(auditLog.action, ["policy.denied", "conversation.turn_failed"]),
          eq(auditLog.resource_id, conversation_id),
        ),
      );
    expect(denials).toHaveLength(2);
    expect(denials).toContainEqual({
      action: "policy.denied",
      actor_type: "user",
      actor_id: userId,
      reason: "execution_authentication_unavailable",
    });
    expect(denials).toContainEqual({
      action: "conversation.turn_failed",
      actor_type: "user",
      actor_id: userId,
      reason: "Queued conversation requires authenticated credential provenance.",
    });
  }, 20_000);

  test("cross-tenant queued principal does not override persisted task caller", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask(
      "deny cross-tenant principal",
    );
    const foreignPrincipal = {
      ...queuedPrincipal,
      id: userId,
      tenant_id: nextUuid(),
    };
    await enqueueRawConversationRunTurn(queue.boss, queue.testDb.db, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      principal: foreignPrincipal,
      kind: "start",
    });
    await waitForTerminal(mcp_task_id);

    const denials = await queue.testDb.db
      .select({
        action: auditLog.action,
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
      })
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          inArray(auditLog.action, ["policy.denied", "conversation.turn_failed"]),
          eq(auditLog.resource_id, conversation_id),
        ),
      );
    expect(denials).toHaveLength(2);
    expect(denials).toHaveLength(2);
    expect(denials.every((entry) => entry.actor_type === "user" && entry.actor_id === userId)).toBe(
      true,
    );
  }, 20_000);

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
    for (let i = 0; i < 12; i++) await flush();
    await waitFor(async () => true, { tries: 8, sleepMs: 250, label: "worker dequeue window" });
    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
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
        actor: { kind: "user", id: userId },
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
        actor: { kind: "user", id: userId },
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

    expect(
      await rearmMcpTaskForNativeElicitation(
        { tenant_id: tenantId, task_id: mcp_task_id, actor: { kind: "user", id: userId } },
        queue.testDb.db,
      ),
    ).toBe(true);
    await setMcpTaskJobId(tenantId, mcp_task_id, resumedAttempt, queue.testDb.db);

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
        actor: { kind: "user", id: userId },
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

    const store = new ConversationTaskStore({ db: queue.testDb.db, tenant_id: tenantId });
    const task = await store.getTask(mcp_task_id);
    expect(task?.status).toBe("failed");
    expect(task?.statusMessage).toContain("overloaded");

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

  test("a normal failure uses persisted task caller instead of an unverified queued actor_id", async () => {
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "fail with mismatched actor" },
      queue.testDb.db,
    );
    const mcp_task_id = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        kind: "start",
        actor: { kind: "user", id: userId },
        request_source: "mcp",
        user_message_id: created.initial_message_id,
      },
      queue.testDb.db,
    );
    const unverifiedActorId = nextUuid();
    getMockProvider().setFailure("runturn-primary", "overloaded");
    getMockProvider().setFailure("runturn-fallback", "overloaded");

    await enqueueRawConversationRunTurn(queue.boss, queue.testDb.db, {
      tenant_id: tenantId,
      conversation_id: created.conversation.id,
      mcp_task_id,
      actor_id: unverifiedActorId,
      principal: queuedPrincipal,
      kind: "start",
    });
    await waitForTerminal(mcp_task_id);

    const [audit] = await queue.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "conversation.turn_failed"),
          eq(auditLog.resource_id, created.conversation.id),
        ),
      );
    expect(audit?.actor_type).toBe("user");
    expect(audit?.actor_id).toBe(userId);
  }, 45_000);

  test("failure audit preserves a persisted system-account caller without a queued principal", async () => {
    const [account] = await queue.testDb.db
      .insert(systemAccounts)
      .values({
        tenant_id: tenantId,
        name: "turn-failure-system-account",
        role_id: await builtinRoleId(queue.testDb.db, "member"),
      })
      .returning({ id: systemAccounts.id });
    if (!account) throw new Error("system account missing");
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: null, initial_message: "fail as system account" },
      queue.testDb.db,
    );
    const mcp_task_id = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        kind: "start",
        actor: { kind: "system_account", id: account.id },
        request_source: "mcp",
        user_message_id: created.initial_message_id,
      },
      queue.testDb.db,
    );
    await enqueueRawConversationRunTurn(queue.boss, queue.testDb.db, {
      tenant_id: tenantId,
      conversation_id: created.conversation.id,
      mcp_task_id,
      actor_id: account.id,
      principal: null,
      kind: "start",
    });
    await waitForTerminal(mcp_task_id);
    const [audit] = await queue.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "conversation.turn_failed"),
          eq(auditLog.resource_id, created.conversation.id),
        ),
      );
    expect(audit?.actor_type).toBe("system_account");
    expect(audit?.actor_id).toBe(account.id);
  }, 45_000);

  test("a missing legacy caller stays unknown and retains the MCP source", async () => {
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "fail without caller" },
      queue.testDb.db,
    );
    const mcp_task_id = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        kind: "start",
        actor: null,
        request_source: "mcp",
        user_message_id: created.initial_message_id,
      },
      queue.testDb.db,
    );
    await enqueueRawConversationRunTurn(queue.boss, queue.testDb.db, {
      tenant_id: tenantId,
      conversation_id: created.conversation.id,
      mcp_task_id,
      actor_id: null,
      kind: "start",
    });
    await waitForTerminal(mcp_task_id);
    const [audit] = await queue.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "conversation.turn_failed"),
          eq(auditLog.resource_id, created.conversation.id),
        ),
      );
    expect(audit?.actor_type).toBe("unknown");
    expect(audit?.actor_id).toBeNull();
    expect((audit?.metadata as { request_source?: string })?.request_source).toBe("mcp");
  }, 45_000);

  test("a provider quota error parks the turn instead of failing it — no failure_reason, job re-enqueued with startAfter", async () => {
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
      if ((data as { provider_limit_parks?: number }).provider_limit_parks) {
        sends.push({ data, options });
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

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.failure_reason).toBeNull();
    expect(row?.result).toBeNull();
    const store = new ConversationTaskStore({ db: queue.testDb.db, tenant_id: tenantId });
    expect((await store.getTask(mcp_task_id))?.status).toBe("working");

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
    expect(row?.failure_reason).toBe("pre_seeded_failure");
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
    expect(row?.result).toBeNull();
    expect(row?.failure_reason).toBeNull();

    const store = new ConversationTaskStore({ db: queue.testDb.db, tenant_id: tenantId });
    const task = await store.getTask(mcp_task_id);
    expect(task?.status).toBe("cancelled");
  }, 20_000);
});

describe("conversation.run-turn worker — elicitation pause", () => {
  test("a turn that pauses on ask_user_* finishes the job but the task derives input_required", async () => {
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "list users from the api" },
      queue.testDb.db,
    );
    const conversation_id = created.conversation.id;
    getMockProvider().setConversePlan(conversation_id, [
      {
        tool: "ask_user_confirm",
        args: {
          question: "Confirm the destructive test checkpoint?",
          kind: "generic",
          summary: "confirm destructive checkpoint",
          destructive: true,
        },
      },
    ]);
    const mcp_task_id = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id,
        kind: "start",
        actor: { kind: "user", id: userId },
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
    expect(row?.result).toBeTruthy();
    expect(row?.failure_reason).toBeNull();
    const [conv] = await queue.testDb.db
      .select({ status: conversations.status })
      .from(conversations)
      .where(eq(conversations.id, conversation_id));
    expect(conv?.status).toBe("awaiting_input");
    const store = new ConversationTaskStore({ db: queue.testDb.db, tenant_id: tenantId });
    const task = await store.getTask(mcp_task_id);
    expect(task?.status).toBe("input_required");
  }, 45_000);
});

describe("conversation.run-turn worker — cancel in the guard window", () => {
  test("a cancel landing in the guard window still stops the turn — no result written", async () => {
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
        actor: { kind: "user", id: userId },
        request_source: "mcp",
        user_message_id: created.initial_message_id,
      },
      queue.testDb.db,
    );
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
    expect(row?.result).toBeNull();
    expect(row?.failure_reason).toBeNull();
    expect((await store.getTask(mcp_task_id))?.status).toBe("cancelled");
  }, 30_000);
});

describe("conversation.run-turn worker — respond_elicitation surface threading", () => {
  test("a failed portal continuation retains the verified approver as its actor", async () => {
    const [approver] = await queue.testDb.db
      .insert(users)
      .values({
        tenant_id: tenantId,
        email: "portal-approver@test.local",
        role_id: await builtinRoleId(queue.testDb.db, "admin"),
      })
      .returning({ id: users.id });
    if (!approver) throw new Error("seed portal approver failed");
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "portal failure seed" },
      queue.testDb.db,
    );
    const elicitation = await createElicitation(
      {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        tool_call_id: null,
        tool_name: "ask_user_text",
        summary: "portal failure probe",
        input: { question: "probe?" },
        actor_id: userId,
      },
      queue.testDb.db,
    );
    const mcp_task_id = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        kind: "respond_elicitation",
        actor: { kind: "user", id: userId },
        request_source: "portal",
        user_message_id: null,
      },
      queue.testDb.db,
    );
    const spy = spyOn(svc, "respondElicitation").mockRejectedValue(
      new Error("portal continuation failed"),
    );
    try {
      await enqueueConversationRunTurn(queue.boss, {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        mcp_task_id,
        actor_id: approver.id,
        kind: "respond_elicitation",
        elicitation_id: elicitation.id,
        answer_channel: "portal",
        approver_user_id: approver.id,
      });
      await waitForTerminal(mcp_task_id);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }

    const [audit] = await queue.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "conversation.turn_failed"),
          eq(auditLog.resource_id, created.conversation.id),
        ),
      );
    expect(audit?.actor_type).toBe("user");
    expect(audit?.actor_id).toBe(approver.id);
  }, 30_000);

  test("a disabled portal approver is unknown in a pre-response failure audit", async () => {
    const [approver] = await queue.testDb.db
      .insert(users)
      .values({
        tenant_id: tenantId,
        email: "disabled-portal-approver@test.local",
        role_id: await builtinRoleId(queue.testDb.db, "admin"),
        status: "disabled",
      })
      .returning({ id: users.id });
    if (!approver) throw new Error("seed disabled portal approver failed");
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "disabled portal failure seed" },
      queue.testDb.db,
    );
    const elicitation = await createElicitation(
      {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        tool_call_id: null,
        tool_name: "ask_user_text",
        summary: "disabled portal failure probe",
        input: { question: "probe?" },
        actor_id: userId,
      },
      queue.testDb.db,
    );
    const mcp_task_id = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        kind: "respond_elicitation",
        actor: { kind: "user", id: userId },
        request_source: "portal",
        user_message_id: null,
      },
      queue.testDb.db,
    );
    const spy = spyOn(svc, "respondElicitation").mockRejectedValue(
      new Error("authorization failed before response"),
    );
    try {
      await enqueueConversationRunTurn(queue.boss, {
        tenant_id: tenantId,
        conversation_id: created.conversation.id,
        mcp_task_id,
        actor_id: approver.id,
        kind: "respond_elicitation",
        elicitation_id: elicitation.id,
        answer_channel: "portal",
        approver_user_id: approver.id,
      });
      await waitForTerminal(mcp_task_id);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }

    const [audit] = await queue.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, tenantId),
          eq(auditLog.action, "conversation.turn_failed"),
          eq(auditLog.resource_id, created.conversation.id),
        ),
      );
    expect(audit?.actor_type).toBe("unknown");
    expect(audit?.actor_id).toBeNull();
  }, 30_000);

  test("the respond branch passes surface:'mcp' into respondElicitation", async () => {
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
        actor: { kind: "user", id: userId },
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
        actor: { kind: "user", id: userId },
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
  test("a queued turn rejects another enqueue for the same dialog", async () => {
    const created = await svc.createConversation(
      { tenant_id: tenantId, actor_id: userId, initial_message: "concurrent turn seed" },
      queue.testDb.db,
    );
    const conversation_id = created.conversation.id;
    getMockProvider().setConversePlan(conversation_id, []);
    const appendA = await svc.appendUserMessage(
      { tenant_id: tenantId, conversation_id, actor_id: userId, message: "MESSAGE-ALPHA" },
      queue.testDb.db,
    );
    const taskA = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id,
        kind: "append",
        actor: { kind: "user", id: userId },
        request_source: "mcp",
        user_message_id: appendA.message_id,
      },
      queue.testDb.db,
    );
    await enqueueConversationRunTurn(queue.boss, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id: taskA,
      actor_id: userId,
      kind: "append",
    });
    await expect(
      svc.appendUserMessage(
        { tenant_id: tenantId, conversation_id, actor_id: userId, message: "MESSAGE-BRAVO" },
        queue.testDb.db,
      ),
    ).rejects.toMatchObject({ code: "conversation_turn_in_progress" });
    await waitForTerminal(taskA);
    const row = await getMcpTask(tenantId, taskA, queue.testDb.db);
    const events = row?.result?.events as Array<{
      type?: string;
      role?: string;
      content?: { text?: string };
    }>;
    expect(
      events.find((event) => event.type === "message" && event.role === "user")?.content?.text,
    ).toBe("MESSAGE-ALPHA");
  }, 30_000);
});

describe("conversation.run-turn worker — parked turn supersession", () => {
  async function completeLaterTurn(conversation_id: string): Promise<void> {
    const laterId = await insertMcpTask(
      {
        tenant_id: tenantId,
        conversation_id,
        kind: "append",
        actor: { kind: "user", id: userId },
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
    expect(row?.parked_reason).toBe("provider_quota_exhausted");
  }, 45_000);

  test("a parked turn with no later completed turn resumes normally", async () => {
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
    expect(row?.parked_until).toBeNull();
  }, 45_000);

  test("an unparked turn is never superseded, even with a later completed turn", async () => {
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

  test("a raw SDK timeout becomes the shared timeout wording in failure_reason and the tool result", async () => {
    const { conversation_id, mcp_task_id } =
      await seedConversationAndTask("hang on the first chunk");
    const sdkTimeout = new Error("First chunk timeout of 90000ms exceeded");
    sdkTimeout.name = "TimeoutError";
    const spy = spyOn(svc, "runConversationTurn").mockImplementation(async () => {
      throw sdkTimeout;
    });
    try {
      await enqueueConversationRunTurn(queue.boss, {
        tenant_id: tenantId,
        conversation_id,
        mcp_task_id,
        actor_id: userId,
        kind: "start",
      });
      await waitForTerminal(mcp_task_id);
    } finally {
      spy.mockRestore();
    }

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.failure_reason).toBe("Timed out after 90 s");
    expect(row?.result).toBeNull();

    const store = new ConversationTaskStore({ db: queue.testDb.db, tenant_id: tenantId });
    const result = await store.getTaskResult(mcp_task_id);
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: "text", text: "Timed out after 90 s" }]);
  }, 45_000);

  test("a provider that never sends its first chunk fails the MCP turn with the same wording the loop uses", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("silent provider");
    getMockProvider().setFailure("runturn-primary", "stream_never_answers");
    _setConverseFirstChunkTimeoutMsForTests(200);
    try {
      await enqueueConversationRunTurn(queue.boss, {
        tenant_id: tenantId,
        conversation_id,
        mcp_task_id,
        actor_id: userId,
        kind: "start",
      });
      await waitForTerminal(mcp_task_id);
    } finally {
      _setConverseFirstChunkTimeoutMsForTests(null);
    }

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.failure_reason).toBe("Timed out after 1 s");
    const store = new ConversationTaskStore({ db: queue.testDb.db, tenant_id: tenantId });
    expect(await store.getTaskResult(mcp_task_id)).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "Timed out after 1 s" }],
    });
  }, 45_000);
});
