// Bug PP regression: a global counter increments on every tool result
// with `ok: false` and resets on the first success. When it reaches
// MAX_CONSECUTIVE_FAILURES (5) the next non-ask_user / non-inspect tool
// dispatch is short-circuited with a structured "ask the user"
// envelope. Mirrors reference impl's "no more than 5 failed tool calls
// in a row" prompt rule.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "../../../db/client.ts";
import { conversations } from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../../llm/tests/setup.ts";
import type { TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { MAX_CONSECUTIVE_FAILURES, type TurnSignals, wrapTools } from "../sdk-wrap.ts";

let ctx: LlmTestCtx;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createLlmTestCtx("consecutive-failures-cap");
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
    toolArgsRepeat: new Map(),
    toolValidationFingerprint: new Map(),
    totalLoopWarnings: 0,
    consecutiveFailures: 0,
    lastAssistantText: "",
  };
}

describe("consecutive-failures cap (Bug PP)", () => {
  test("MAX_CONSECUTIVE_FAILURES is 5 (mirrors reference impl)", () => {
    expect(MAX_CONSECUTIVE_FAILURES).toBe(5);
  });

  test("counter starts at 0 on a fresh TurnSignals", () => {
    const signals = freshSignals();
    expect(signals.consecutiveFailures).toBe(0);
  });

  test("dispatcher short-circuits any non-inspect / non-ask_user tool when cap is reached", async () => {
    const signals = freshSignals();
    signals.consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
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
    // update_param is a workflow-authoring tool that the LLM was
    // hammering in session 16d6e46a's 30-iteration loop. Once the cap
    // is reached, the next call returns the structured "ask the user"
    // envelope without running the tool body.
    const updateParam = wrapped.update_param;
    expect(updateParam).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (updateParam!.execute as any)(
      { workflow_step_id: "fetch", field: "method", value: "POST" },
      { toolCallId: "t1", messages: [] },
    );
    expect(result.data?.error_code ?? result.error_code).toBe("consecutive_failures_cap");
    expect(result.data?.next_best_actions ?? result.next_best_actions).toContain("ask_user_choice");
  });

  test("ask_user_* tools BYPASS the cap (recovery path)", async () => {
    const signals = freshSignals();
    signals.consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
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
    const wrapped = wrapTools(toolCtx, signals, events, ctx.testDb.db as unknown as Db, [], {});
    const askUserChoice = wrapped.ask_user_choice;
    expect(askUserChoice).toBeDefined();
    // The tool body runs (returns its normal pause shape with an
    // elicitation). The cap envelope must NOT fire here — otherwise
    // the model would have no way to break the loop.
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (askUserChoice!.execute as any)(
      {
        question: "Pick one",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      },
      { toolCallId: "t1", messages: [] },
    );
    // Whatever ask_user_choice returns, it should NOT be the cap envelope.
    expect(result.data?.error_code ?? result.error_code).not.toBe("consecutive_failures_cap");
  });

  test("inspect_workflow / inspect_execution_step BYPASS the cap (read-only recovery)", async () => {
    const signals = freshSignals();
    signals.consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
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
    const inspectWorkflow = wrapped.inspect_workflow;
    expect(inspectWorkflow).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (inspectWorkflow!.execute as any)(
      { sections: ["instruction"] },
      { toolCallId: "t1", messages: [] },
    );
    expect(result.data?.error_code ?? result.error_code).not.toBe("consecutive_failures_cap");
  });
});
