import { afterAll, beforeAll } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import * as svc from "../../conversations/service.ts";
import { sessions, tenants, users } from "../../db/schema/index.ts";
import { resetMockProvider } from "../../llm/mock-provider.ts";
import { getMcpTask, insertMcpTask } from "../../mcp/tasks/store.ts";
import { builtinRoleId } from "../../rbac/roles.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { createQueueCtx, type QueueTestCtx } from "../tests/setup.ts";
import { ensureTestConfig } from "../tests/test-config.ts";
import {
  enqueueConversationRunTurn as enqueueRawConversationRunTurn,
  registerConversationRunTurnHandler,
} from "./conversation-run-turn.ts";

export let queue: QueueTestCtx;

export let tenantId: string;

export let userId: string;

export let queuedPrincipal: ResolvedPrincipal;

export const nextUuid = createDeterministicUuidFactory(0xc011a026);

export function enqueueConversationRunTurn(
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

export async function waitForTerminal(taskId: string): Promise<void> {
  await waitFor(
    async () => {
      const row = await getMcpTask(tenantId, taskId, queue.testDb.db);
      return Boolean(row && (row.result || row.failure_reason || row.cancelled_at));
    },
    { tries: 120, sleepMs: 250, label: "mcp_task terminal state" },
  );
}

export async function seedConversationAndTask(
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

export function useRunTurnQueue(): void {
  beforeAll(async () => {
    process.env.LLM_PROVIDER = "mock";
    await ensureTestConfig();
    resetMockProvider();
    queue = await createQueueCtx("conversation_run_turn");
    const t = await seedTenant(queue.testDb.db, { slug: "t-runturn", display_name: "RunTurn" });
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
}
