import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { llmUsage, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { currentMonthBucket } from "../llm/accounting/index.ts";
import { EngineClient } from "./index.ts";

let testDb: TestDb;

beforeAll(async () => {
  testDb = await createTestDb("engine_client_llm_usage");
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("EngineClient user LLM usage", () => {
  test("monthly and recent user usage exclude a system account with a colliding UUID", async () => {
    const [tenant] = await testDb.db
      .insert(tenants)
      .values({ slug: "engine-client-llm-usage", display_name: "Engine client LLM usage" })
      .returning();
    if (!tenant) throw new Error("tenant insert returned no row");

    const userId = "20000000-0000-4000-8000-000000000001";
    await testDb.db.insert(llmUsage).values([
      {
        tenant_id: tenant.id,
        flow: "converse",
        model: "mock",
        prompt_tokens: 100,
        completion_tokens: 0,
        total_tokens: 100,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        latency_ms: 10,
        result: "success",
        user_id: userId,
        actor_type: "user",
        month_bucket: currentMonthBucket(),
      },
      {
        tenant_id: tenant.id,
        flow: "converse",
        model: "mock",
        prompt_tokens: 10_000,
        completion_tokens: 0,
        total_tokens: 10_000,
        cache_read_tokens: 0,
        cache_creation_tokens: 0,
        latency_ms: 10,
        result: "success",
        user_id: userId,
        actor_type: "system_account",
        month_bucket: currentMonthBucket(),
      },
    ]);

    const metrics = new EngineClient({ tenant_id: tenant.id, actor_id: null, db: testDb.db })
      .metrics;
    const recent = await metrics.llmUsageRecentForUser(userId);

    expect(await metrics.monthlyTokenUsageForUser(userId)).toBe(100);
    expect(recent).toHaveLength(1);
    expect(recent[0]?.actor_type).toBe("user");
  });
});
