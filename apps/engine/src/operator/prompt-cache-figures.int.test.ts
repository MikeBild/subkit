import { afterAll, beforeAll, expect, test } from "bun:test";
import { tenants } from "../db/schema/identity.ts";
import { llmUsage } from "../db/schema/llm.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { readOperatingFigures } from "./operating-figures.ts";

const FROM = new Date("2024-01-01T00:00:00.000Z");
const TO = new Date("2024-01-02T00:00:00.000Z");
const INSIDE = new Date("2024-01-01T12:00:00.000Z");
const OUTSIDE = new Date("2024-01-03T12:00:00.000Z");

let testDb: TestDb;
let tenantId: string;

function usage(
  tenant: string,
  flow: string,
  prompt: number,
  cacheRead: number,
  at: Date,
): typeof llmUsage.$inferInsert {
  return {
    tenant_id: tenant,
    flow,
    model: "claude-haiku-4-5",
    prompt_tokens: prompt,
    completion_tokens: 10,
    total_tokens: prompt + 10,
    cache_read_tokens: cacheRead,
    cache_creation_tokens: 0,
    latency_ms: 100,
    result: "success",
    created_at: at,
    month_bucket: at.getUTCFullYear() * 100 + (at.getUTCMonth() + 1),
  };
}

beforeAll(async () => {
  testDb = await createTestDb("prompt_cache_figures");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-prompt-cache", display_name: "Prompt cache" })
    .returning();
  const [other] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-prompt-cache-other", display_name: "Other" })
    .returning();
  tenantId = tenant!.id;
  await testDb.db
    .insert(llmUsage)
    .values([
      usage(tenantId, "converse", 1_000, 900, INSIDE),
      usage(tenantId, "converse", 1_000, 700, INSIDE),
      usage(tenantId, "generate", 400, 0, INSIDE),
      usage(tenantId, "generate", 9_000, 9_000, OUTSIDE),
      usage(other!.id, "converse", 50_000, 0, INSIDE),
    ]);
});

afterAll(async () => {
  await testDb.cleanup();
});

test("the operating figures carry the tenant's prompt-cache share per flow in the window", async () => {
  const figures = await readOperatingFigures(testDb.db, tenantId, { from: FROM, to: TO });
  expect(figures.prompt_cache.flows).toEqual([
    {
      flow: "converse",
      calls: 2,
      prompt_tokens: 2_000,
      cache_read_tokens: 1_600,
      cache_read_percent: 80,
    },
    { flow: "generate", calls: 1, prompt_tokens: 400, cache_read_tokens: 0, cache_read_percent: 0 },
  ]);
});
