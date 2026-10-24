import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { llmUsage, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { currentMonthBucket } from "../llm/accounting/budget.ts";
import { FROZEN_NOW } from "../test-helpers/determinism/clock.ts";
import { adminPrincipal } from "../test-helpers/principals.ts";
import { buildAttention, invalidateAttention } from "./attention.ts";
import { providerOutageFrom } from "./provider-outage.ts";

const QUOTA_MESSAGE =
  "You exceeded your current quota, please check your plan and billing details. insufficient_quota";

let testDb: TestDb;

async function seedTenant(slug: string): Promise<string> {
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug, display_name: slug })
    .returning({ id: tenants.id });
  if (!tenant) throw new Error("seed tenant failed");
  return tenant.id;
}

async function seedCalls(
  tenant_id: string,
  calls: Array<{ result: "success" | "error"; error?: string; minutesAgo: number }>,
): Promise<void> {
  const now = FROZEN_NOW;
  await testDb.db.insert(llmUsage).values(
    calls.map((call) => ({
      tenant_id,
      flow: "converse",
      model: "openai:gpt-5.6-sol",
      prompt_tokens: 10,
      completion_tokens: 0,
      total_tokens: 10,
      latency_ms: 5,
      result: call.result,
      error: call.error ?? null,
      month_bucket: currentMonthBucket(new Date(now)),
      created_at: new Date(now - call.minutesAgo * 60_000),
    })),
  );
}

async function providerItems(tenant_id: string) {
  invalidateAttention(tenant_id);
  const attention = await buildAttention(testDb.db, adminPrincipal(tenant_id), {
    now: new Date(FROZEN_NOW),
  });
  return attention.items.filter((item) => item.kind.startsWith("llm_provider_"));
}

beforeAll(async () => {
  testDb = await createTestDb("provider-outage");
}, 60_000);

afterAll(async () => {
  await testDb.cleanup();
}, 30_000);

describe("provider outage in the attention feed", () => {
  test("consecutive quota refusals stop the tenant and name the cause", async () => {
    const tenant_id = await seedTenant("provider-outage-quota");
    await seedCalls(tenant_id, [
      { result: "success", minutesAgo: 30 },
      { result: "error", error: QUOTA_MESSAGE, minutesAgo: 20 },
      { result: "error", error: QUOTA_MESSAGE, minutesAgo: 10 },
    ]);
    const items = await providerItems(tenant_id);
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item?.kind).toBe("llm_provider_quota");
    expect(item?.class).toBe("stopped");
    expect(item?.severity).toBe("critical");
    expect(item?.reason).toBe("risk_critical");
    expect(item?.counts.consecutive_failures).toBe(2);
    expect(item?.detail).toContain("insufficient_quota");
    expect(item?.actions[0]?.permission).toBe("settings:read");
  });

  test("a success after the failures clears the outage", async () => {
    const tenant_id = await seedTenant("provider-outage-recovered");
    await seedCalls(tenant_id, [
      { result: "error", error: "503 service unavailable", minutesAgo: 20 },
      { result: "error", error: "503 service unavailable", minutesAgo: 15 },
      { result: "success", minutesAgo: 5 },
    ]);
    expect(await providerItems(tenant_id)).toHaveLength(0);
  });

  test("a single failure or failures outside the window raise nothing", async () => {
    const single = await seedTenant("provider-outage-single");
    await seedCalls(single, [{ result: "error", error: "503 service unavailable", minutesAgo: 5 }]);
    expect(await providerItems(single)).toHaveLength(0);

    const old = await seedTenant("provider-outage-old");
    await seedCalls(old, [
      { result: "error", error: "503 service unavailable", minutesAgo: 120 },
      { result: "error", error: "503 service unavailable", minutesAgo: 90 },
    ]);
    expect(await providerItems(old)).toHaveLength(0);
  });
});

describe("providerOutageFrom", () => {
  const at = (minutesAgo: number) => new Date(Date.UTC(2026, 9, 21, 12, 0) - minutesAgo * 60_000);

  test("non-quota failures report an unavailable provider since the first failure", () => {
    const outage = providerOutageFrom([
      { result: "error", error: "upstream 502", created_at: at(1) },
      { result: "error", error: "timeout", created_at: at(4) },
      { result: "success", error: null, created_at: at(9) },
    ]);
    expect(outage).toEqual({
      kind: "llm_provider_unavailable",
      failures: 2,
      since: at(4).toISOString(),
      last_error: "upstream 502",
    });
  });

  test("a refused token budget is not a provider failure", () => {
    expect(
      providerOutageFrom([
        { result: "quota_exhausted", error: "llm_quota_exhausted", created_at: at(1) },
        { result: "quota_exhausted", error: "llm_quota_exhausted", created_at: at(2) },
      ]),
    ).toBeNull();
  });
});
