import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { llmUsage, tenantLlmSettings } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { invoke } from "../core/invoke.ts";
import { runGenerateFlow } from "../flows/generate.ts";
import { getMockProvider } from "../mock-provider.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

let ctx: LlmTestCtx;

beforeAll(async () => {
  ctx = await createLlmTestCtx("routing");
  // Pin the primary/fallback so the test asserts on known ids.
  await ctx.testDb.db.insert(tenantLlmSettings).values({
    tenant_id: ctx.tenant_id,
    llm_provider: "mock",
    llm_primary_model: "mock-primary-1",
    llm_fallback_model: "mock-fallback-1",
  });
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("llm/routing", () => {
  test("falls back exactly once on overloaded and logs the event", async () => {
    // Queue a one-shot overloaded error on the primary model. Uses a
    // chat-frequency flow (`converse`) — `generate`/`judge` are
    // code-elevated to the fallback model and never dispatch to the
    // primary in the first place (see applyFlowModelElevation).
    getMockProvider().setFailure("mock-primary-1", "overloaded");

    const events: Array<Record<string, unknown>> = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- logger spy
    const priorWarn: any = logger.warn.bind(logger);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- logger spy
    (logger as any).warn = (payload: Record<string, unknown>) => {
      events.push(payload);
      return priorWarn(payload);
    };

    try {
      const result = await invoke(
        {
          flow: "converse",
          tenant_id: ctx.tenant_id,
          user_turns: [{ role: "user", content: "list the first two users" }],
          connector_id: ctx.connector_id,
        },
        ctx.testDb.db,
      );
      expect(result.fell_back).toBe(true);
      expect(result.model_used).toBe("mock-fallback-1");
    } finally {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restore logger
      (logger as any).warn = priorWarn;
    }

    // Exactly one successful usage row for the fallback model.
    const successRows = await ctx.testDb.db
      .select()
      .from(llmUsage)
      .where(
        and(
          eq(llmUsage.tenant_id, ctx.tenant_id),
          eq(llmUsage.model, "mock-fallback-1"),
          eq(llmUsage.result, "success"),
        ),
      );
    expect(successRows.length).toBe(1);

    // One error usage row for the primary model.
    const errorRows = await ctx.testDb.db
      .select()
      .from(llmUsage)
      .where(
        and(
          eq(llmUsage.tenant_id, ctx.tenant_id),
          eq(llmUsage.model, "mock-primary-1"),
          eq(llmUsage.result, "error"),
        ),
      );
    expect(errorRows.length).toBe(1);

    const triggered = events.find((e) => e.action === "fallback.triggered");
    expect(triggered).toBeDefined();
  });

  test("generate flow is code-elevated to the tenant's fallback (stronger) model", async () => {
    // No failure queued — the elevation alone routes the dispatch to
    // the fallback model id; this is NOT the error-fallback path.
    const result = await runGenerateFlow(
      {
        tenant_id: ctx.tenant_id,
        description: "list the first two users",
        connector_id: ctx.connector_id,
      },
      ctx.testDb.db,
    );
    expect(result.model_used).toBe("mock-fallback-1");
    expect(result.fell_back).toBe(false);
  });
});
