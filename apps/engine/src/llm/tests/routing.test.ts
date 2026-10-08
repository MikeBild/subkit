import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { llmUsage, tenants } from "../../db/schema/index.ts";
import { logger } from "../../logging/logger.ts";
import { invoke } from "../core/invoke.ts";
import { runGenerateFlow } from "../flows/generate.ts";
import { getMockProvider } from "../mock-provider.ts";
import { createLlmTestCtx, type LlmTestCtx } from "./setup.ts";

let ctx: LlmTestCtx;

beforeAll(async () => {
  ctx = await createLlmTestCtx("routing");
  await ctx.testDb.db
    .update(tenants)
    .set({ llm_primary: "mock-primary-1", llm_fallback: "mock-fallback-1" })
    .where(eq(tenants.id, ctx.tenant_id));
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("llm/routing", () => {
  test("falls back exactly once on overloaded and logs the event", async () => {
    getMockProvider().setFailure("mock-primary-1", "overloaded");

    const events: Array<Record<string, unknown>> = [];
    // biome-ignore lint/suspicious/noExplicitAny: logger spy
    const priorWarn: any = logger.warn.bind(logger);
    // biome-ignore lint/suspicious/noExplicitAny: logger spy
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
      // biome-ignore lint/suspicious/noExplicitAny: restore logger
      (logger as any).warn = priorWarn;
    }

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
