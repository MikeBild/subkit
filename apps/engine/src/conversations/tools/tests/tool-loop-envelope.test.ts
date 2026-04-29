// Bug 3a — the loop-breaker must return a STRUCTURED envelope with
// next_best_actions (ask_user_choice, ask_user_text) so the LLM can
// recover gracefully instead of cutting mid-sentence with "I've hit a
// tool call limit. Let me analyze..." (session 09219b6d). Also pins
// the new tenant_read cap of 6 (raised from 3) so tools like
// inspect_execution_step can be called enough times to debug a
// non-trivial workflow without the mid-debug abort.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Db } from "../../../db/client.ts";
import { conversations } from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../../llm/tests/setup.ts";
import type { TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { type TurnSignals, wrapTools } from "../sdk-wrap.ts";

let ctx: LlmTestCtx;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createLlmTestCtx("tool-loop-envelope");
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  conversation_id = row!.id;
});

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
});

function freshSignals(): TurnSignals {
  return {
    step: 0,
    toolChain: Promise.resolve(),
    pendingChildToolCallIds: [],
    pendingChildElicitationIds: [],
    toolInvocationCount: new Map(),
    toolLastErrorHash: new Map(),
    totalLoopWarnings: 0,
    consecutiveFailures: 0,
    lastAssistantText: "",
  };
}

describe("loop-breaker structured envelope", () => {
  it("tenant_read cap is 6 (not 3) — inspect_execution_step calls 4 + 5 + 6 succeed", async () => {
    const signals = freshSignals();
    const events: TurnEvent[] = [];
    const engineClient = new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: null,
      actor_type: "system",
      db: ctx.testDb.db as unknown as Db,
    });
    const toolCtx: ToolContext = {
      db: ctx.testDb.db as unknown as Db,
      tenant_id: ctx.tenant_id,
      conversation_id,
      actor_id: null,
      connector_id: null,
      workflow_id: null,
      engineClient,
      getDraft: () => ({ workflow: { name: "", steps: [] } }),
      setDraft: async () => {},
    };
    const wrapped = wrapTools(
      toolCtx,
      signals,
      events,
      ctx.testDb.db as unknown as Db,
      ["workflow-authoring"],
      {},
    );
    const inspect = wrapped.inspect_execution_step;
    expect(inspect).toBeDefined();
    // Call 4× — pre-fix this would short-circuit on call 4 (cap=3).
    // Post-fix the cap is 6, so calls 1-6 should bypass the loop
    // breaker and only hit the tool's own error path
    // (execution_not_found here because no execution was seeded).
    for (let i = 1; i <= 4; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      const result = await (inspect!.execute as any)(
        {
          execution_id: "00000000-0000-0000-0000-000000000000",
          step_key: "any",
        },
        { toolCallId: `t${i}`, messages: [] },
      );
      // tool_loop_detected is the loop-breaker error; until call 7 we
      // should NEVER see it.
      const data = result.data as { error_code?: string };
      expect(data.error_code).not.toBe("tool_loop_detected");
    }
    // Now invocation count is 4. Three more calls (5, 6) are fine, 7 trips.
    for (let i = 5; i <= 6; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      const result = await (inspect!.execute as any)(
        {
          execution_id: "00000000-0000-0000-0000-000000000000",
          step_key: "any",
        },
        { toolCallId: `t${i}`, messages: [] },
      );
      const data = result.data as { error_code?: string };
      expect(data.error_code).not.toBe("tool_loop_detected");
    }
    // 7th call MUST trip the cap.
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result7 = await (inspect!.execute as any)(
      {
        execution_id: "00000000-0000-0000-0000-000000000000",
        step_key: "any",
      },
      { toolCallId: "t7", messages: [] },
    );
    const data7 = result7.data as {
      error_code?: string;
      next_best_actions?: string[];
      message?: string;
    };
    expect(data7.error_code).toBe("tool_loop_detected");
    // Structured recovery hint — the LLM gets concrete next actions
    // (ask_user_choice / ask_user_text) instead of a vague "stop".
    expect(data7.next_best_actions).toEqual(
      expect.arrayContaining(["ask_user_choice", "ask_user_text"]),
    );
    // Message tells the LLM to USE the structured tools, not write
    // prose. Pre-fix the message was a vague "change approach".
    expect(data7.message).toContain("ask_user_choice");
  });
});
