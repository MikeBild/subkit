import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { llmUsage, tenants } from "../../db/schema/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import {
  getMetrics,
  METRIC_NAMES,
  resetMetricsRegistryForTests,
} from "../../observability/metrics.ts";
import { _setConverseFirstChunkTimeoutMsForTests } from "../loop.ts";
import { describeTurnFailure, LlmTimeoutError, turnFailureFramePayload } from "../turn-failure.ts";
import {
  type ConversationTestCtx,
  createConversationTestCtx,
  createConversationWithTurn,
} from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("llm_timeout");
});

afterAll(async () => {
  _setConverseFirstChunkTimeoutMsForTests(null);
  await ctx.cleanup();
});

describe("conversations/loop — a provider that never sends its first chunk", () => {
  test("the turn ends as llm_timeout with the first-chunk phase, counts once and tries no fallback", async () => {
    resetMockProvider();
    resetMetricsRegistryForTests();
    await ctx.testDb.db
      .update(tenants)
      .set({ llm_primary: "silent-primary", llm_fallback: "silent-fallback" })
      .where(eq(tenants.id, ctx.tenant_id));
    getMockProvider().setFailure("silent-primary", "stream_never_answers");
    _setConverseFirstChunkTimeoutMsForTests(200);

    let caught: unknown;
    try {
      await createConversationWithTurn(
        {
          tenant_id: ctx.tenant_id,
          actor_id: ctx.user_id,
          connector_id: ctx.connector_id,
          initial_message: "hello",
        },
        ctx.testDb.db,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LlmTimeoutError);
    const failure = describeTurnFailure(caught);
    expect(failure).toMatchObject({
      code: "llm_timeout",
      message: "Timed out after 1 s",
      timeout: { phase: "first_chunk", timeout_ms: 200 },
    });
    expect(turnFailureFramePayload(failure)).toEqual({
      code: "llm_timeout",
      message: "Timed out after 1 s",
      details: { phase: "first_chunk", timeout_ms: 200 },
    });

    const timeouts = getMetrics()
      .snapshot()
      .find((s) => s.name === METRIC_NAMES.LLM_STEP_TIMEOUT_TOTAL);
    expect(timeouts?.samples).toEqual([
      { name: METRIC_NAMES.LLM_STEP_TIMEOUT_TOTAL, labels: { phase: "first_chunk" }, value: 1 },
    ]);

    const primaryErrors = await ctx.testDb.db
      .select()
      .from(llmUsage)
      .where(
        and(
          eq(llmUsage.tenant_id, ctx.tenant_id),
          eq(llmUsage.model, "silent-primary"),
          eq(llmUsage.result, "error"),
        ),
      );
    expect(primaryErrors).toHaveLength(1);
    const fallbackAttempts = await ctx.testDb.db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.tenant_id, ctx.tenant_id), eq(llmUsage.model, "silent-fallback")));
    expect(fallbackAttempts).toHaveLength(0);
  });

  test("a provider that accepts the request but never answers it ends as llm_timeout with the response budget and counts once", async () => {
    resetMockProvider();
    resetMetricsRegistryForTests();
    await ctx.testDb.db
      .update(tenants)
      .set({ llm_primary: "mute-primary", llm_fallback: "mute-fallback" })
      .where(eq(tenants.id, ctx.tenant_id));
    getMockProvider().setFailure("mute-primary", "response_never_arrives");

    let caught: unknown;
    try {
      await createConversationWithTurn(
        {
          tenant_id: ctx.tenant_id,
          actor_id: ctx.user_id,
          connector_id: ctx.connector_id,
          initial_message: "hello",
        },
        ctx.testDb.db,
      );
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(LlmTimeoutError);
    expect(describeTurnFailure(caught)).toMatchObject({
      code: "llm_timeout",
      message: "Timed out after 120 s",
      timeout: { phase: "first_chunk", timeout_ms: 120_000 },
    });

    const timeouts = getMetrics()
      .snapshot()
      .find((s) => s.name === METRIC_NAMES.LLM_STEP_TIMEOUT_TOTAL);
    expect(timeouts?.samples).toEqual([
      { name: METRIC_NAMES.LLM_STEP_TIMEOUT_TOTAL, labels: { phase: "first_chunk" }, value: 1 },
    ]);

    const fallbackAttempts = await ctx.testDb.db
      .select()
      .from(llmUsage)
      .where(and(eq(llmUsage.tenant_id, ctx.tenant_id), eq(llmUsage.model, "mute-fallback")));
    expect(fallbackAttempts).toHaveLength(0);
  });
});
