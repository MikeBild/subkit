// GC6 — per-tenant monthly token budget enforcement.
//
// Seeds `tenant_llm_settings.llm_monthly_token_budget = 1000` and
// pre-inserts `llm_usage` rows totaling 995 tokens in the current
// month. A subsequent `runGenerateFlow` for that tenant must raise
// `LlmQuotaExhausted` because the projected prompt tokens (~1024+)
// push the tenant over the cap.
//
// The test also directly exercises `checkAndDecrement` so the helper's
// behaviour is pinned independently of the flow orchestration path.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { llmUsage, tenantLlmSettings } from "../../db/schema/index.ts";
import { checkAndDecrement, currentMonthBucket } from "../accounting/index.ts";
import { LlmQuotaExhausted } from "../errors.ts";
import { runGenerateFlow } from "../flows/generate.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

let ctx: LlmTestCtx;

beforeAll(async () => {
  ctx = await createLlmTestCtx("budget-enforcement");
  await ctx.testDb.db.insert(tenantLlmSettings).values({
    tenant_id: ctx.tenant_id,
    llm_provider: "mock",
    llm_monthly_token_budget: 1000,
  });
  // Pre-seed 995 tokens of historic usage in the current month so the
  // budget is deliberately near the edge.
  const bucket = currentMonthBucket();
  await ctx.testDb.db.insert(llmUsage).values([
    {
      tenant_id: ctx.tenant_id,
      flow: "generate",
      model: "mock",
      prompt_tokens: 500,
      completion_tokens: 0,
      total_tokens: 500,
      latency_ms: 10,
      result: "success",
      month_bucket: bucket,
    },
    {
      tenant_id: ctx.tenant_id,
      flow: "generate",
      model: "mock",
      prompt_tokens: 495,
      completion_tokens: 0,
      total_tokens: 495,
      latency_ms: 10,
      result: "success",
      month_bucket: bucket,
    },
  ]);
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("llm/checkAndDecrement", () => {
  test("reports ok=false when projected tokens push usage over the cap", async () => {
    const verdict = await checkAndDecrement(ctx.tenant_id, 10, ctx.testDb.db);
    expect(verdict.budget).toBe(1000);
    expect(verdict.used).toBe(995);
    expect(verdict.remaining).toBe(5);
    expect(verdict.ok).toBe(false);
  });

  test("returns ok=true when the projected call fits", async () => {
    const verdict = await checkAndDecrement(ctx.tenant_id, 1, ctx.testDb.db);
    expect(verdict.ok).toBe(true);
    expect(verdict.remaining).toBe(5);
  });

  test("runGenerateFlow raises LlmQuotaExhausted when budget is exhausted", async () => {
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
  });
});
