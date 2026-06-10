// error-code-repeat-cap — per-tool same-error_code streak breaker.
//
// Regression guard for the authoring-gate thrash: a tool returning the
// SAME structured `error_code` with FRESH args, interleaved with
// successful read calls, slipped past both the global
// `consecutiveFailures` cap (reset on any success) and the
// `toolValidationFingerprint` tracker (only fires on Zod `errors[]`
// arrays). The new `toolErrorCodeRepeat` streaker catches it at
// MAX_ERROR_CODE_REPEAT regardless of arg variation or interleaved
// reads.
//
// Harness mirrors consecutive-failures-cap.test.ts exactly — wrapTools
// requires a live DB for the DB writes in wrapOne.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "../../../db/client.ts";
import { conversations } from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../../llm/tests/setup.ts";
import type { TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import { MAX_ERROR_CODE_REPEAT } from "../sdk-wrap/state.ts";
import { type TurnSignals, wrapTools } from "../sdk-wrap.ts";

let ctx: LlmTestCtx;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createLlmTestCtx("error-code-repeat-cap");
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
    toolErrorCodeRepeat: new Map(),
    totalLoopWarnings: 0,
    consecutiveFailures: 0,
    lastAssistantText: "",
    lastExecutionSuccess: null,
  };
}

function makeToolCtx(): ToolContext {
  const engineClient = new EngineClient({
    tenant_id: ctx.tenant_id,
    actor_id: null,
    actor_type: "system",
    db: ctx.testDb.db as unknown as Db,
  });
  // Draft with a transform step referencing an unrun upstream step.
  // update_param("format", "expression", ...) will predictably return
  // error_code: "transform_authoring_requires_inspect" because no
  // dry-run has recorded a preview for "fetch".
  const draft = {
    workflow: {
      name: "test-wf",
      steps: [
        { id: "fetch", kind: "request", method: "GET", url: "https://example.com/items" },
        { id: "format", kind: "transform", expression: "$scope.fetch.data.items" },
      ],
    },
  };
  return {
    db: ctx.testDb.db as unknown as Db,
    tenant_id: ctx.tenant_id,
    conversation_id,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient,
    getDraft: () => draft as ReturnType<ToolContext["getDraft"]>,
    setDraft: async () => {},
  };
}

describe("error-code-repeat-cap (MAX_ERROR_CODE_REPEAT)", () => {
  test("MAX_ERROR_CODE_REPEAT is 4", () => {
    expect(MAX_ERROR_CODE_REPEAT).toBe(4);
  });

  test("toolErrorCodeRepeat initialised to empty Map on fresh TurnSignals", () => {
    const signals = freshSignals();
    expect(signals.toolErrorCodeRepeat).toBeInstanceOf(Map);
    expect(signals.toolErrorCodeRepeat.size).toBe(0);
  });

  // Case 1: same error_code, different args — trips on call MAX_ERROR_CODE_REPEAT+1
  // (after MAX_ERROR_CODE_REPEAT recorded failures). No interleave needed because
  // MAX_ERROR_CODE_REPEAT (4) < MAX_CONSECUTIVE_FAILURES (5), so the global cap
  // does not fire first.
  test(`write tool trips on call ${MAX_ERROR_CODE_REPEAT + 1} when same error_code repeats ${MAX_ERROR_CODE_REPEAT}× with different args`, async () => {
    const signals = freshSignals();
    const events: TurnEvent[] = [];
    const toolCtx = makeToolCtx();
    const wrapped = await wrapTools(
      toolCtx,
      signals,
      events,
      ctx.testDb.db as unknown as Db,
      ["workflow-authoring"],
      {},
    );
    const updateParam = wrapped.update_param;
    expect(updateParam).toBeDefined();

    // Calls 1–MAX_ERROR_CODE_REPEAT: inner tool runs and returns
    // transform_authoring_requires_inspect. Each call uses a different
    // expression value to prove args vary.
    for (let i = 1; i <= MAX_ERROR_CODE_REPEAT; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      const result = await (updateParam!.execute as any)(
        { step_id: "format", param: "expression", value: `$scope.fetch.data.variant_${i}` },
        { toolCallId: `t${i}`, messages: [] },
      );
      const errCode = result.data?.error_code ?? result.error_code;
      // The inner tool runs and returns the authoring gate refusal — NOT
      // the loop-breaker envelope yet.
      expect(errCode).toBe("transform_authoring_requires_inspect");
    }
    // After MAX_ERROR_CODE_REPEAT failures the streak is at MAX_ERROR_CODE_REPEAT.
    const streak = signals.toolErrorCodeRepeat.get("update_param");
    expect(streak?.count).toBe(MAX_ERROR_CODE_REPEAT);
    expect(streak?.code).toBe("transform_authoring_requires_inspect");

    // Call MAX_ERROR_CODE_REPEAT+1: the breaker fires BEFORE the inner tool
    // runs. We confirm by checking the returned error_code is the breaker
    // code, not the inner gate code (transform_authoring_requires_inspect).
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const resultTrip = await (updateParam!.execute as any)(
      {
        step_id: "format",
        param: "expression",
        value: `$scope.fetch.data.variant_${MAX_ERROR_CODE_REPEAT + 1}`,
      },
      { toolCallId: `t${MAX_ERROR_CODE_REPEAT + 1}`, messages: [] },
    );
    const errCodeTrip = resultTrip.data?.error_code ?? resultTrip.error_code;
    expect(["tool_error_repeat", "turn_loop_budget_exhausted"]).toContain(errCodeTrip);
    // The breaker envelope always includes next_best_actions pointing to
    // ask_user_choice or ask_user_text.
    const actionsTrip = resultTrip.data?.next_best_actions ?? resultTrip.next_best_actions ?? [];
    expect(actionsTrip).toEqual(expect.arrayContaining(["ask_user_choice", "ask_user_text"]));
  });

  // Case 2: streak survives interleaved successful read-only tool calls
  // (the core regression — `consecutiveFailures` would have reset on any
  // success; `toolErrorCodeRepeat` must NOT).
  // We run MAX_ERROR_CODE_REPEAT failure+inspect pairs, asserting the
  // streak grows each round and consecutiveFailures resets on each
  // inspect. After the loop the streak is at MAX_ERROR_CODE_REPEAT and
  // the next call trips.
  test("streak survives interleaved inspect_workflow success — write tool still trips", async () => {
    const signals = freshSignals();
    const events: TurnEvent[] = [];
    const toolCtx = makeToolCtx();
    const wrapped = await wrapTools(
      toolCtx,
      signals,
      events,
      ctx.testDb.db as unknown as Db,
      ["workflow-authoring"],
      {},
    );
    const updateParam = wrapped.update_param;
    const inspectWorkflow = wrapped.inspect_workflow;
    expect(updateParam).toBeDefined();
    expect(inspectWorkflow).toBeDefined();

    // Accumulate MAX_ERROR_CODE_REPEAT failures, each interleaved with a
    // successful inspect_workflow call that resets consecutiveFailures but
    // must NOT reset the per-tool toolErrorCodeRepeat streak.
    for (let i = 1; i <= MAX_ERROR_CODE_REPEAT; i++) {
      // Failure i on update_param.
      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      await (updateParam!.execute as any)(
        { step_id: "format", param: "expression", value: `$scope.fetch.data.v${i}` },
        { toolCallId: `u${i}`, messages: [] },
      );
      expect(signals.toolErrorCodeRepeat.get("update_param")?.count).toBe(i);
      expect(signals.consecutiveFailures).toBeGreaterThan(0);

      // Interleave: inspect_workflow succeeds. consecutiveFailures resets;
      // update_param's streak must survive.
      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      const inspectResult = await (inspectWorkflow!.execute as any)(
        { sections: ["instruction"] },
        { toolCallId: `insp${i}`, messages: [] },
      );
      // inspect_workflow returned ok (may be empty draft but not an error
      // from the loop-breaker).
      expect(inspectResult.data?.error_code ?? inspectResult.error_code).not.toBe(
        "consecutive_failures_cap",
      );
      // consecutiveFailures must now be 0.
      expect(signals.consecutiveFailures).toBe(0);
      // Streak for update_param must still be at i — not cleared by the
      // inspect success (which targets a different tool entry).
      expect(signals.toolErrorCodeRepeat.get("update_param")?.count).toBe(i);
    }

    // The streak is now at MAX_ERROR_CODE_REPEAT. The next call must trip
    // despite all the interleaved successful reads.
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (updateParam!.execute as any)(
      {
        step_id: "format",
        param: "expression",
        value: `$scope.fetch.data.v${MAX_ERROR_CODE_REPEAT + 1}`,
      },
      { toolCallId: `u${MAX_ERROR_CODE_REPEAT + 1}`, messages: [] },
    );
    const errCode = result.data?.error_code ?? result.error_code;
    expect(["tool_error_repeat", "turn_loop_budget_exhausted"]).toContain(errCode);
    // The breaker envelope names the repeated code so the model can
    // surface a concrete blocker message.
    expect(result.data?.repeated_error_code ?? result.repeated_error_code).toBe(
      "transform_authoring_requires_inspect",
    );
  });

  // Case 3: a DIFFERENT error_code resets the streak (no premature trip).
  // Specifically: two failures with code A, then one failure with code B
  // (different), then the streak for A is gone and B is at count 1.
  // The new streak of B must not trip until it has accumulated
  // MAX_ERROR_CODE_REPEAT failures of its own.
  test("different error_code resets the streak — counter goes back to 1", async () => {
    const signals = freshSignals();
    const events: TurnEvent[] = [];
    const toolCtx = makeToolCtx();
    const wrapped = await wrapTools(
      toolCtx,
      signals,
      events,
      ctx.testDb.db as unknown as Db,
      ["workflow-authoring"],
      {},
    );
    const updateParam = wrapped.update_param;
    const inspectWorkflow = wrapped.inspect_workflow;
    expect(updateParam).toBeDefined();
    expect(inspectWorkflow).toBeDefined();

    // Two failures with transform_authoring_requires_inspect (code A).
    for (let i = 1; i <= 2; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      await (updateParam!.execute as any)(
        { step_id: "format", param: "expression", value: `$scope.fetch.data.x${i}` },
        { toolCallId: `ta${i}`, messages: [] },
      );
    }
    expect(signals.toolErrorCodeRepeat.get("update_param")?.count).toBe(2);
    expect(signals.toolErrorCodeRepeat.get("update_param")?.code).toBe(
      "transform_authoring_requires_inspect",
    );

    // Reset the global consecutive-failures counter via a successful
    // inspect call so it doesn't interfere with the error_code streak
    // test below (5 consecutive failures would trip the global cap first).
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    await (inspectWorkflow!.execute as any)(
      { sections: ["instruction"] },
      { toolCallId: "ix", messages: [] },
    );
    expect(signals.consecutiveFailures).toBe(0);
    // update_param's streak survives the inspect success.
    expect(signals.toolErrorCodeRepeat.get("update_param")?.count).toBe(2);

    // Now a call that produces a DIFFERENT error_code: point at a
    // non-existent step → error_code: "unknown_step".
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const resultDiff = await (updateParam!.execute as any)(
      { step_id: "does_not_exist", param: "expression", value: "x" },
      { toolCallId: "tb1", messages: [] },
    );
    const diffCode = resultDiff.data?.error_code ?? resultDiff.error_code;
    expect(diffCode).toBe("unknown_step");
    // Streak reset to 1 for the new code — the old transform streak is gone.
    const streakAfter = signals.toolErrorCodeRepeat.get("update_param");
    expect(streakAfter?.count).toBe(1);
    expect(streakAfter?.code).toBe("unknown_step");

    // Accumulate the remaining MAX_ERROR_CODE_REPEAT-1 failures with
    // unknown_step (streak goes 2 … MAX_ERROR_CODE_REPEAT). Each failure
    // is interleaved with an inspect to keep consecutiveFailures from
    // reaching the global cap before the error_code breaker fires.
    for (let i = 2; i <= MAX_ERROR_CODE_REPEAT; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      await (inspectWorkflow!.execute as any)(
        { sections: ["instruction"] },
        { toolCallId: `iy${i}`, messages: [] },
      );
      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      await (updateParam!.execute as any)(
        { step_id: "does_not_exist", param: "expression", value: `y${i}` },
        { toolCallId: `tc${i}`, messages: [] },
      );
      expect(signals.toolErrorCodeRepeat.get("update_param")?.count).toBe(i);
    }
    expect(signals.toolErrorCodeRepeat.get("update_param")?.count).toBe(MAX_ERROR_CODE_REPEAT);
    expect(signals.toolErrorCodeRepeat.get("update_param")?.code).toBe("unknown_step");

    // Reset global counter before the trip call.
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    await (inspectWorkflow!.execute as any)(
      { sections: ["instruction"] },
      { toolCallId: "iw", messages: [] },
    );
    // Next call with unknown_step must trip on the error_code_repeat breaker.
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const resultTrip = await (updateParam!.execute as any)(
      { step_id: "does_not_exist", param: "expression", value: "trip" },
      { toolCallId: "td1", messages: [] },
    );
    const tripCode = resultTrip.data?.error_code ?? resultTrip.error_code;
    expect(["tool_error_repeat", "turn_loop_budget_exhausted"]).toContain(tripCode);
  });

  // Case 4a: ask_user_* tools are NEVER short-circuited even with a
  // mature streak on another tool.
  test("ask_user_choice bypasses the breaker even when totalLoopWarnings is high", async () => {
    const signals = freshSignals();
    // Pre-load the streak to MAX and warnings to the threshold.
    signals.toolErrorCodeRepeat.set("update_param", {
      code: "transform_authoring_requires_inspect",
      count: MAX_ERROR_CODE_REPEAT,
    });
    signals.totalLoopWarnings = 1;
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
      getDraft: () =>
        ({ workflow: { name: "", steps: [] } }) as ReturnType<ToolContext["getDraft"]>,
      setDraft: async () => {},
    };
    const wrapped = await wrapTools(
      toolCtx,
      signals,
      events,
      ctx.testDb.db as unknown as Db,
      [],
      {},
    );
    const askUserChoice = wrapped.ask_user_choice;
    expect(askUserChoice).toBeDefined();
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (askUserChoice!.execute as any)(
      {
        question: "What should I do next?",
        options: [
          { value: "inspect", label: "Run inspect_workflow_draft" },
          { value: "stop", label: "Stop and let me fix this" },
        ],
      },
      { toolCallId: "ask1", messages: [] },
    );
    // ask_user_* tools must never receive the loop-breaker envelope.
    const errCode = result.data?.error_code ?? result.error_code;
    expect(errCode).not.toBe("tool_error_repeat");
    expect(errCode).not.toBe("turn_loop_budget_exhausted");
  });

  // Case 4b: inspect_* tools are NEVER short-circuited by this breaker.
  test("inspect_workflow bypasses the breaker even when streak is at cap", async () => {
    const signals = freshSignals();
    signals.toolErrorCodeRepeat.set("update_param", {
      code: "transform_authoring_requires_inspect",
      count: MAX_ERROR_CODE_REPEAT,
    });
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
      getDraft: () =>
        ({
          workflow: { name: "", steps: [] },
        }) as ReturnType<ToolContext["getDraft"]>,
      setDraft: async () => {},
    };
    const wrapped = await wrapTools(
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
      { toolCallId: "insp1", messages: [] },
    );
    const errCode = result.data?.error_code ?? result.error_code;
    expect(errCode).not.toBe("tool_error_repeat");
    expect(errCode).not.toBe("turn_loop_budget_exhausted");
  });
});
