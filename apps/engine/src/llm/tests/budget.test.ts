import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { setConfigKey } from "../../config/loader.ts";
import { llmUsage, tenantLlmSettings } from "../../db/schema/index.ts";
import { monthlyUsage } from "../accounting/index.ts";
import { LlmQuotaExhausted } from "../errors.ts";
import { runGenerateFlow } from "../flows/generate.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

let ctx: LlmTestCtx;

beforeAll(async () => {
  ctx = await createLlmTestCtx("budget");
  await ctx.testDb.db.insert(tenantLlmSettings).values({
    tenant_id: ctx.tenant_id,
    llm_provider: "mock",
  });
  await setConfigKey("tokens.monthly_budget", 200, { tenantId: ctx.tenant_id, force: true });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("llm/budget", () => {
  test("trips LlmQuotaExhausted and records a usage row", async () => {
    await expect(
      runGenerateFlow(
        {
          tenant_id: ctx.tenant_id,
          description: "list users",
          connector_id: ctx.connector_id,
        },
        ctx.testDb.db,
      ),
    ).rejects.toBeInstanceOf(LlmQuotaExhausted);

    const rows = await ctx.testDb.db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.tenant_id, ctx.tenant_id), eq(llmUsage.result, "quota_exhausted")));
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.result).toBe("quota_exhausted");
    expect(rows[0]?.error).toBe("llm_quota_exhausted");
  });

  test("a refused call spends nothing: the month's usage does not move, retry after retry", async () => {
    const before = await monthlyUsage(ctx.tenant_id, ctx.testDb.db);
    for (let i = 0; i < 2; i++) {
      await expect(
        runGenerateFlow(
          { tenant_id: ctx.tenant_id, description: "list users", connector_id: ctx.connector_id },
          ctx.testDb.db,
        ),
      ).rejects.toBeInstanceOf(LlmQuotaExhausted);
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
