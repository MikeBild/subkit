import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { llmUsage, tenantLlmSettings } from "../../db/schema/index.ts";
import { LlmQuotaExhausted } from "../errors.ts";
import { runGenerateFlow } from "../flows/generate.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

let ctx: LlmTestCtx;

beforeAll(async () => {
  ctx = await createLlmTestCtx("budget");
  // Seed a tiny budget — 200 tokens is smaller than any real prompt we
  // assemble, so the very first call should trip the budget check.
  await ctx.testDb.db.insert(tenantLlmSettings).values({
    tenant_id: ctx.tenant_id,
    llm_provider: "mock",
    llm_monthly_token_budget: 200,
  });
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
});
