import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../db/schema/identity.ts";
import { llmUsage } from "../db/schema/llm.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { aggregateLlm } from "./aggregate-llm.ts";

const skip = process.env.REQUIRES_PG === "0";

let testDb: TestDb;
let tenantId: string;
let otherTenantId: string;

const FROM = new Date("2024-02-01T00:00:00.000Z");
const TO = new Date("2024-02-02T00:00:00.000Z");
const INSIDE_TS = new Date("2024-02-01T12:00:00.000Z");

const USER_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const USER_B = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function monthBucket(d: Date): number {
  return d.getUTCFullYear() * 100 + (d.getUTCMonth() + 1);
}

function baseRow(overrides: Partial<typeof llmUsage.$inferInsert> = {}) {
  return {
    tenant_id: tenantId,
    flow: "converse",
    model: "claude-haiku-4-5",
    prompt_tokens: 100,
    completion_tokens: 50,
    total_tokens: 150,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    latency_ms: 100,
    result: "success" as const,
    created_at: INSIDE_TS,
    month_bucket: monthBucket(INSIDE_TS),
    ...overrides,
  };
}

beforeAll(async () => {
  if (skip) return;

  testDb = await createTestDb("stats-agg-llm-user");

  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "agg-llm-user-tenant", display_name: "Agg LLM User Tenant" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;

  const [otherTenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "agg-llm-user-other", display_name: "Agg LLM User Other" })
    .returning();
  if (!otherTenant) throw new Error("seed other tenant failed");
  otherTenantId = otherTenant.id;
}, 60_000);

afterAll(async () => {
  if (!skip && testDb?.cleanup) await testDb.cleanup();
}, 30_000);

afterEach(async () => {
  if (skip) return;
  await testDb.db.delete(llmUsage);
}, 30_000);

describe.skipIf(skip)("aggregateLlm — groupBy:user", () => {
  test("groupBy:['user'] produces per-user group keys with correct call counts", async () => {
    await testDb.db
      .insert(llmUsage)
      .values([
        baseRow({ user_id: USER_A, actor_type: "user" }),
        baseRow({ user_id: USER_A, actor_type: "user", prompt_tokens: 200, total_tokens: 250 }),
        baseRow({ user_id: USER_B, actor_type: "user", prompt_tokens: 80, total_tokens: 130 }),
      ]);

    const result = await aggregateLlm(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: ["user"],
    });

    expect(result.groups).toHaveLength(2);

    const userAGroup = result.groups.find((g) => g.key.user === USER_A);
    const userBGroup = result.groups.find((g) => g.key.user === USER_B);

    expect(userAGroup).toBeDefined();
    expect(userBGroup).toBeDefined();
    expect(userAGroup!.totals.calls).toBe(2);
    expect(userBGroup!.totals.calls).toBe(1);
  });

  test("groupBy:['user'] token sums are correct per user", async () => {
    await testDb.db
      .insert(llmUsage)
      .values([
        baseRow({ user_id: USER_A, actor_type: "user", total_tokens: 150 }),
        baseRow({ user_id: USER_A, actor_type: "user", total_tokens: 300 }),
      ]);

    const result = await aggregateLlm(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: ["user"],
    });

    const userAGroup = result.groups.find((g) => g.key.user === USER_A);
    expect(userAGroup!.totals.tokens.total).toBe(450);
  });

  test("groupBy:['user'] excludes a system account sharing a user's UUID", async () => {
    await testDb.db
      .insert(llmUsage)
      .values([
        baseRow({ user_id: USER_A, actor_type: "user", total_tokens: 150 }),
        baseRow({ user_id: USER_A, actor_type: "system_account", total_tokens: 900 }),
      ]);

    const result = await aggregateLlm(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: ["user"],
    });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]?.key.user).toBe(USER_A);
    expect(result.groups[0]?.totals.tokens.total).toBe(150);
  });

  test("groupBy:['user'] row with null user_id appears under empty key", async () => {
    await testDb.db
      .insert(llmUsage)
      .values([
        baseRow({ user_id: null, actor_type: "system" }),
        baseRow({ user_id: USER_A, actor_type: "user" }),
      ]);

    const result = await aggregateLlm(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: ["user"],
    });

    const nullGroup = result.groups.find((g) => g.key.user === "");
    const userAGroup = result.groups.find((g) => g.key.user === USER_A);
    expect(nullGroup).toBeDefined();
    expect(nullGroup!.totals.calls).toBe(1);
    expect(userAGroup!.totals.calls).toBe(1);
  });
});

describe.skipIf(skip)("aggregateLlm — userId filter", () => {
  test("userId filter narrows results to only that user's rows", async () => {
    await testDb.db
      .insert(llmUsage)
      .values([
        baseRow({ user_id: USER_A, actor_type: "user", total_tokens: 150 }),
        baseRow({ user_id: USER_B, actor_type: "user", total_tokens: 999 }),
      ]);

    const result = await aggregateLlm(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: [],
      userId: USER_A,
    });

    expect(result.totals.calls.total).toBe(1);
    expect(result.totals.tokens.total).toBe(150);
  });

  test("userId filter excludes a system account sharing the user's UUID", async () => {
    await testDb.db
      .insert(llmUsage)
      .values([
        baseRow({ user_id: USER_A, actor_type: "user", total_tokens: 150 }),
        baseRow({ user_id: USER_A, actor_type: "system_account", total_tokens: 900 }),
      ]);

    const result = await aggregateLlm(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: [],
      userId: USER_A,
    });

    expect(result.totals.calls.total).toBe(1);
    expect(result.totals.tokens.total).toBe(150);
  });

  test("userId filter + groupBy:['user'] narrows to that user only", async () => {
    await testDb.db
      .insert(llmUsage)
      .values([
        baseRow({ user_id: USER_A, actor_type: "user", total_tokens: 150 }),
        baseRow({ user_id: USER_A, actor_type: "user", total_tokens: 200 }),
        baseRow({ user_id: USER_B, actor_type: "user", total_tokens: 999 }),
      ]);

    const result = await aggregateLlm(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: ["user"],
      userId: USER_A,
    });

    expect(result.groups).toHaveLength(1);
    expect(result.groups[0]!.key.user).toBe(USER_A);
    expect(result.groups[0]!.totals.calls).toBe(2);
  });

  test("cross-tenant isolation with userId filter — other tenant's rows for same user_id excluded", async () => {
    const bucket = monthBucket(INSIDE_TS);

    await testDb.db.insert(llmUsage).values({
      tenant_id: otherTenantId,
      flow: "converse",
      model: "claude-haiku-4-5",
      prompt_tokens: 9999,
      completion_tokens: 9999,
      total_tokens: 19_998,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
      latency_ms: 100,
      result: "success",
      user_id: USER_A,
      actor_type: "user",
      created_at: INSIDE_TS,
      month_bucket: bucket,
    });

    await testDb.db
      .insert(llmUsage)
      .values(baseRow({ user_id: USER_A, actor_type: "user", total_tokens: 150 }));

    const result = await aggregateLlm(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: [],
      userId: USER_A,
    });

    expect(result.totals.calls.total).toBe(1);
    expect(result.totals.tokens.total).toBe(150);
  });

  test("userId filter returns zero when user has no rows in window", async () => {
    await testDb.db.insert(llmUsage).values(baseRow({ user_id: USER_B, actor_type: "user" }));

    const result = await aggregateLlm(testDb.db, {
      tenantId,
      bucket: "hour",
      from: FROM,
      to: TO,
      tz: "UTC",
      groupBy: [],
      userId: USER_A,
    });

    expect(result.totals.calls.total).toBe(0);
  });
});
