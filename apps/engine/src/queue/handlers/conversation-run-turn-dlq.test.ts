import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { getConfig, loadConfig } from "../../config/loader.ts";
import * as svc from "../../conversations/service.ts";
import { auditLog, tenants, users } from "../../db/schema/index.ts";
import { getMcpTask, insertMcpTask, setMcpTaskCancelled } from "../../mcp/tasks/store.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { CONVERSATION_RUN_TURN_DLQ } from "../queues.ts";
import { createQueueCtx, type QueueTestCtx } from "../tests/setup.ts";
import { registerConversationRunTurnDlqHandler } from "./conversation-run-turn-dlq.ts";

let queue: QueueTestCtx;
let tenantId: string;
let userId: string;

async function ensureConfig(): Promise<void> {
  try {
    getConfig();
    return;
  } catch {}
  const dir = mkdtempSync(join(tmpdir(), "sk-cfg-runturn-dlq-test-"));
  await loadConfig({
    env: { DATABASE_URL: "postgres://placeholder/runturn-dlq-test", NODE_ENV: "test" },
    configPathOverride: join(dir, "subkit.config.json"),
  });
}

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  await ensureConfig();
  queue = await createQueueCtx("conversation_run_turn_dlq");
  const [t] = await queue.testDb.db
    .insert(tenants)
    .values({ slug: "t-runturn-dlq", display_name: "RunTurnDLQ" })
    .returning();
  if (!t) throw new Error("seed tenant failed");
  tenantId = t.id;
  const [u] = await queue.testDb.db
    .insert(users)
    .values({
      tenant_id: tenantId,
      email: "rt-dlq@test.local",
      role_id: await builtinRoleId(queue.testDb.db, "admin"),
    })
    .returning();
  if (!u) throw new Error("seed user failed");
  userId = u.id;
  await registerConversationRunTurnDlqHandler({ boss: queue.boss, db: queue.testDb.db });
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
      user_message_id: created.initial_message_id,
    },
    queue.testDb.db,
  );
  return { conversation_id: created.conversation.id, mcp_task_id: taskId };
}

describe("conversation.run-turn.dlq consumer", () => {
  test("B1: a dead-lettered job marks the non-terminal mcp_tasks row failed/worker_expired + writes the audit row", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("worker dies mid-turn");
    const before = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(before?.result).toBeNull();
    expect(before?.failure_reason).toBeNull();

    await queue.boss.send(CONVERSATION_RUN_TURN_DLQ, {
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
      { tries: 80, sleepMs: 250, label: "mcp_task worker_expired" },
    );

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.failure_reason).toBe("worker_expired");
    expect(row?.result).toBeNull();

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
    expect(audits).toHaveLength(1);
    expect(audits[0]?.result).toBe("error");
    expect(audits[0]?.reason).toBe("worker_expired");
    expect((audits[0]!.metadata as { mcp_task_id?: string }).mcp_task_id).toBe(mcp_task_id);
    expect((audits[0]!.metadata as { dead_lettered?: boolean }).dead_lettered).toBe(true);
  }, 30_000);

  test("B1: a dead-lettered job whose mcp_tasks row is already terminal is an idempotent no-op", async () => {
    const { conversation_id, mcp_task_id } = await seedConversationAndTask("already cancelled");
    await setMcpTaskCancelled(tenantId, mcp_task_id, queue.testDb.db);

    await queue.boss.send(CONVERSATION_RUN_TURN_DLQ, {
      tenant_id: tenantId,
      conversation_id,
      mcp_task_id,
      actor_id: userId,
      kind: "start",
    });

    await waitFor(async () => true, { tries: 12, sleepMs: 250, label: "dlq dequeue window" });

    const row = await getMcpTask(tenantId, mcp_task_id, queue.testDb.db);
    expect(row?.cancelled_at).toBeInstanceOf(Date);
    expect(row?.failure_reason).toBeNull();
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
  }, 30_000);
});
