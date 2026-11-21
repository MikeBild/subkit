import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setConfigKey } from "../../config/loader.ts";
import { llmUsage, tenants } from "../../db/schema/index.ts";
import { setTestNow } from "../../test-helpers/determinism/clock.ts";
import { checkAndDecrement, currentMonthBucket } from "../accounting/index.ts";
import { readSpend, spendVerdict } from "../accounting/spend.ts";
import { LlmSpendLimitReached } from "../errors.ts";
import { runGenerateFlow } from "../flows/generate.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

const NOW = Date.parse("2026-11-21T10:00:00Z");
let ctx: LlmTestCtx;

async function spend(model: string, completion_tokens: number, created_at: string): Promise<void> {
  await ctx.testDb.db.insert(llmUsage).values({
    tenant_id: ctx.tenant_id,
    flow: "converse",
    model,
    prompt_tokens: 0,
    completion_tokens,
    total_tokens: completion_tokens,
    latency_ms: 1,
    result: "success",
    month_bucket: currentMonthBucket(new Date(created_at)),
    created_at: new Date(created_at),
  });
}

async function workspace(set: Partial<typeof tenants.$inferInsert>): Promise<void> {
  await ctx.testDb.db.update(tenants).set(set).where(eq(tenants.id, ctx.tenant_id));
}

beforeAll(async () => {
  ctx = await createLlmTestCtx("spend-budget");
  setTestNow(() => NOW);
  await ctx.testDb.db
    .update(tenants)
    .set({ timezone: "Europe/Berlin" })
    .where(eq(tenants.id, ctx.tenant_id));
  await spend("claude-sonnet-4-5", 2_000_000, "2026-11-05T09:00:00Z");
  await spend("claude-sonnet-4-5", 1_000_000, "2026-10-31T23:30:00Z");
  await spend("claude-sonnet-4-5", 5_000_000, "2026-10-31T22:30:00Z");
  await spend("local-llama", 9_000_000, "2026-11-06T09:00:00Z");
});

afterEach(async () => {
  await workspace({ spend_limit_usd: 50, spend_continue_month: null });
  await setConfigKey("tokens.currency", "USD", { tenantId: ctx.tenant_id, force: true });
});

afterAll(async () => {
  setTestNow(null);
  await ctx.cleanup();
});

describe("the monthly dollar budget", () => {
  test("sums priced calls of the month in the workspace time zone and skips unpriced ones", async () => {
    const reading = await readSpend(ctx.tenant_id, ctx.testDb.db);
    expect(reading.month).toBe("2026-11");
    expect(reading.spent_usd).toBe(45);
    expect(reading.unpriced_calls).toBe(1);
    expect(reading.limit_usd).toBe(50);
    expect(reading.state).toBe("warning");
  });

  test("lets model work run below the limit", async () => {
    expect(
      (await spendVerdict(ctx.tenant_id, { kind: "flow", flow: "converse" }, ctx.testDb.db)).ok,
    ).toBe(true);
    expect((await checkAndDecrement(ctx.tenant_id, 10, ctx.testDb.db)).ok).toBe(true);
  });

  test("pauses every model call boundary once the limit is reached", async () => {
    await workspace({ spend_limit_usd: 40 });
    const verdict = await checkAndDecrement(ctx.tenant_id, 10, ctx.testDb.db);
    expect(verdict.ok).toBe(false);
    expect(verdict.scope).toBe("spend");
    expect(verdict.spend).toMatchObject({ limit_usd: 40, spent_usd: 45, month: "2026-11" });
    const error = await runGenerateFlow(
      { tenant_id: ctx.tenant_id, description: "list users", connector_id: ctx.connector_id },
      ctx.testDb.db,
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(LlmSpendLimitReached);
  });

  test("continuing this month lifts the pause", async () => {
    await workspace({ spend_limit_usd: 40 });
    await workspace({ spend_continue_month: "2026-11" });
    expect((await checkAndDecrement(ctx.tenant_id, 10, ctx.testDb.db)).ok).toBe(true);
    expect((await readSpend(ctx.tenant_id, ctx.testDb.db)).state).toBe("continued");
  });

  test("no limit and a non-USD price basis never pause", async () => {
    await workspace({ spend_limit_usd: 0 });
    expect((await readSpend(ctx.tenant_id, ctx.testDb.db)).state).toBe("unlimited");
    await workspace({ spend_limit_usd: 1 });
    await setConfigKey("tokens.currency", "EUR", { tenantId: ctx.tenant_id, force: true });
    const reading = await readSpend(ctx.tenant_id, ctx.testDb.db);
    expect(reading).toMatchObject({ countable: false, state: "unlimited", spent_usd: 0 });
    expect((await checkAndDecrement(ctx.tenant_id, 10, ctx.testDb.db)).ok).toBe(true);
  });
});
