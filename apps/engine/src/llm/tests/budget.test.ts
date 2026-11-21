import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { llmUsage, tenants } from "../../db/schema/index.ts";
import { now } from "../../utils/clock.ts";
import { currentMonthBucket, monthlyUsage } from "../accounting/index.ts";
import { LlmSpendLimitReached } from "../errors.ts";
import { runGenerateFlow } from "../flows/generate.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

let ctx: LlmTestCtx;

beforeAll(async () => {
  ctx = await createLlmTestCtx("budget");
  await ctx.testDb.db
    .update(tenants)
    .set({ spend_limit_usd: 0.01 })
    .where(eq(tenants.id, ctx.tenant_id));
  const at = new Date(now());
  await ctx.testDb.db.insert(llmUsage).values({
    tenant_id: ctx.tenant_id,
    flow: "converse",
    model: "claude-sonnet-4-5",
    completion_tokens: 100_000,
    total_tokens: 100_000,
    result: "success",
    month_bucket: currentMonthBucket(at),
    created_at: at,
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("llm/budget", () => {
  test("trips LlmSpendLimitReached and records a usage row", async () => {
    await expect(
      runGenerateFlow(
        {
          tenant_id: ctx.tenant_id,
          description: "list users",
          connector_id: ctx.connector_id,
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(LlmSpendLimitReached);

    const rows = await ctx.testDb.db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.tenant_id, ctx.tenant_id), eq(llmUsage.result, "quota_exhausted")));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.result).toBe("quota_exhausted");
    expect(rows[0]?.error).toBe("llm_spend_limit_reached");
  });

  test("a refused call spends nothing: the month's usage does not move, retry after retry", async () => {
    const before = await monthlyUsage(ctx.tenant_id, ctx.testDb.db);
    for (let i = 0; i < 2; i++) {
      await expect(
        runGenerateFlow(
          { tenant_id: ctx.tenant_id, description: "list users", connector_id: ctx.connector_id },
          ctx.testDb.db,
        ),
      ).rejects.toBeInstanceOf(LlmSpendLimitReached);
    }
    expect(await monthlyUsage(ctx.tenant_id, ctx.testDb.db)).toBe(before);
    const rows = await ctx.testDb.db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.tenant_id, ctx.tenant_id), eq(llmUsage.result, "quota_exhausted")));
    expect(rows.length).toBeGreaterThanOrEqual(3);
    for (const row of rows) {
      expect(row.prompt_tokens).toBe(0);
      expect(row.total_tokens).toBe(0);
    }
  });
});
