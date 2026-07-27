// A parked turn must announce itself, not masquerade as "working".
//
// Production, 21 hours: the LLM provider reported its monthly quota exhausted
// and named 2026-08-01 as the reset. The engine did the right thing — it
// re-enqueued the turn with a future `startAfter` instead of failing it — but
// the task row stayed non-terminal and unchanged, so `conversation_get` kept
// answering `working / phase: "starting" / last_action: null`.
//
// That silence is what cost the time: a careful reader concluded a worker was
// hung and went hunting for it. Nothing was hung. Every fact needed to explain
// the wait existed — in the engine log, where the waiting client could not see
// it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { conversations, mcpTasks, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { clearMcpTaskPark, parkedStateForConversation, setMcpTaskParked } from "./store.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("mcp_task_park_visibility");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-park", display_name: "T-PARK" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedTurn(): Promise<{ conversation_id: string; task_id: string }> {
  const [conv] = await ctx.db
    .insert(conversations)
    .values({ tenant_id, status: "active" })
    .returning({ id: conversations.id });
  const [task] = await ctx.db
    .insert(mcpTasks)
    .values({
      tenant_id,
      conversation_id: conv!.id,
      turn_seq: 1,
      kind: "start",
      actor_id: null,
      request_source: "mcp",
      user_message_id: null,
    })
    .returning({ id: mcpTasks.id });
  return { conversation_id: conv!.id, task_id: task!.id };
}

describe("a parked turn is legible to whoever is waiting", () => {
  test("parking records WHEN it resumes and WHY it stopped", async () => {
    const { conversation_id, task_id } = await seedTurn();
    // Before: indistinguishable from an actively running turn.
    expect(await parkedStateForConversation(tenant_id, conversation_id, ctx.db)).toBeNull();

    const until = new Date(Date.now() + 6 * 24 * 60 * 60_000); // allow-wall-clock
    await setMcpTaskParked(tenant_id, task_id, until, "provider_quota_exhausted", ctx.db);

    const parked = await parkedStateForConversation(tenant_id, conversation_id, ctx.db);
    expect(parked?.parked_until.toISOString()).toBe(until.toISOString());
    expect(parked?.parked_reason).toBe("provider_quota_exhausted");
  });

  test("a park whose time has passed is no longer reported", async () => {
    const { conversation_id, task_id } = await seedTurn();
    await setMcpTaskParked(
      tenant_id,
      task_id,
      new Date(Date.now() - 60_000), // allow-wall-clock
      "provider_quota_exhausted",
      ctx.db,
    );
    // The turn is due — claiming it is still parked would be its own lie.
    expect(await parkedStateForConversation(tenant_id, conversation_id, ctx.db)).toBeNull();
  });

  test("a settled turn is never reported as parked", async () => {
    const { conversation_id, task_id } = await seedTurn();
    await setMcpTaskParked(
      tenant_id,
      task_id,
      new Date(Date.now() + 60 * 60_000), // allow-wall-clock
      "provider_quota_exhausted",
      ctx.db,
    );
    await ctx.db
      .update(mcpTasks)
      .set({ result: { status: "completed" } })
      .where(and(eq(mcpTasks.tenant_id, tenant_id), eq(mcpTasks.id, task_id)));

    expect(await parkedStateForConversation(tenant_id, conversation_id, ctx.db)).toBeNull();
  });

  test("the stamp is cleared when the turn actually runs", async () => {
    const { conversation_id, task_id } = await seedTurn();
    await setMcpTaskParked(
      tenant_id,
      task_id,
      new Date(Date.now() + 60 * 60_000), // allow-wall-clock
      "provider_quota_exhausted",
      ctx.db,
    );
    expect(await parkedStateForConversation(tenant_id, conversation_id, ctx.db)).not.toBeNull();

    await clearMcpTaskPark(tenant_id, task_id, ctx.db);
    // Keeping a stale "parked until" on a running turn would mislead exactly
    // as much as the original silence did.
    expect(await parkedStateForConversation(tenant_id, conversation_id, ctx.db)).toBeNull();
  });
});
