import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { conversations, mcpTasks } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { clearMcpTaskPark, parkedStateForConversation, setMcpTaskParked } from "./store.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("mcp_task_park_visibility");
  const t = await seedTenant(ctx.db, { slug: "t-park", display_name: "T-PARK" });
  tenant_id = t.id;
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
    expect(await parkedStateForConversation(tenant_id, conversation_id, ctx.db)).toBeNull();
  });
});
