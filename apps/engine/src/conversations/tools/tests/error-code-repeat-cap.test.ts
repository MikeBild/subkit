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

const CODE_A = "patch_invalid";
const badIdPatch = (i: number) => ({
  patches: [{ op: "replace", path: "/steps/0/id", value: i }],
});

const CODE_B = "workflow_unsupported_placeholder";
const badPlaceholderPatch = (i: number | string) => ({
  patches: [
    { op: "replace", path: "/steps/0/url", value: `https://example.com/\${user.email}?v=${i}` },
  ],
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
  const draft = {
    workflow: {
      name: "test-wf",
      slug: "test-wf",
      steps: [
        { id: "fetch", kind: "request", method: "GET", url: "https://example.com/items" },
        {
          id: "format",
          kind: "transform",
          language: "javascript",
          expression: "return input.scope.fetch.data.items;",
        },
      ],
    },
    latest_preview: { ok: false, step_id: null, summary: "stage evidence", step_traces: [] },
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
    const editPatch = wrapped.edit_workflow_patch;
    expect(editPatch).toBeDefined();

    for (let i = 1; i <= MAX_ERROR_CODE_REPEAT; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      const result = await (editPatch!.execute as any)(badIdPatch(i), {
        toolCallId: `t${i}`,
        messages: [],
      });
      const errCode = result.data?.error_code ?? result.error_code;
      expect(errCode).toBe(CODE_A);
    }
    const streak = signals.toolErrorCodeRepeat.get("edit_workflow_patch");
    expect(streak?.count).toBe(MAX_ERROR_CODE_REPEAT);
    expect(streak?.code).toBe(CODE_A);

    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const resultTrip = await (editPatch!.execute as any)(badIdPatch(MAX_ERROR_CODE_REPEAT + 1), {
      toolCallId: `t${MAX_ERROR_CODE_REPEAT + 1}`,
      messages: [],
    });
    const errCodeTrip = resultTrip.data?.error_code ?? resultTrip.error_code;
    expect(["tool_error_repeat", "turn_loop_budget_exhausted"]).toContain(errCodeTrip);
    const actionsTrip = resultTrip.data?.next_best_actions ?? resultTrip.next_best_actions ?? [];
    expect(actionsTrip).toEqual(expect.arrayContaining(["ask_user_choice", "ask_user_text"]));
  });

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
    const editPatch = wrapped.edit_workflow_patch;
    const inspectWorkflow = wrapped.inspect_workflow;
    expect(editPatch).toBeDefined();
    expect(inspectWorkflow).toBeDefined();

    for (let i = 1; i <= MAX_ERROR_CODE_REPEAT; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      await (editPatch!.execute as any)(badIdPatch(i), { toolCallId: `u${i}`, messages: [] });
      expect(signals.toolErrorCodeRepeat.get("edit_workflow_patch")?.count).toBe(i);
      expect(signals.consecutiveFailures).toBeGreaterThan(0);

      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      const inspectResult = await (inspectWorkflow!.execute as any)(
        { sections: ["instruction"] },
        { toolCallId: `insp${i}`, messages: [] },
      );
      expect(inspectResult.data?.error_code ?? inspectResult.error_code).not.toBe(
        "consecutive_failures_cap",
      );
      expect(signals.consecutiveFailures).toBe(0);
      expect(signals.toolErrorCodeRepeat.get("edit_workflow_patch")?.count).toBe(i);
    }

    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (editPatch!.execute as any)(badIdPatch(MAX_ERROR_CODE_REPEAT + 1), {
      toolCallId: `u${MAX_ERROR_CODE_REPEAT + 1}`,
      messages: [],
    });
    const errCode = result.data?.error_code ?? result.error_code;
    expect(["tool_error_repeat", "turn_loop_budget_exhausted"]).toContain(errCode);
    expect(result.data?.repeated_error_code ?? result.repeated_error_code).toBe(CODE_A);
  });

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
    const editPatch = wrapped.edit_workflow_patch;
    const inspectWorkflow = wrapped.inspect_workflow;
    expect(editPatch).toBeDefined();
    expect(inspectWorkflow).toBeDefined();

    for (let i = 1; i <= 2; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      await (editPatch!.execute as any)(badIdPatch(i), { toolCallId: `ta${i}`, messages: [] });
    }
    expect(signals.toolErrorCodeRepeat.get("edit_workflow_patch")?.count).toBe(2);
    expect(signals.toolErrorCodeRepeat.get("edit_workflow_patch")?.code).toBe(CODE_A);

    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    await (inspectWorkflow!.execute as any)(
      { sections: ["instruction"] },
      { toolCallId: "ix", messages: [] },
    );
    expect(signals.consecutiveFailures).toBe(0);
    expect(signals.toolErrorCodeRepeat.get("edit_workflow_patch")?.count).toBe(2);

    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const resultDiff = await (editPatch!.execute as any)(badPlaceholderPatch(1), {
      toolCallId: "tb1",
      messages: [],
    });
    const diffCode = resultDiff.data?.error_code ?? resultDiff.error_code;
    expect(diffCode).toBe(CODE_B);
    const streakAfter = signals.toolErrorCodeRepeat.get("edit_workflow_patch");
    expect(streakAfter?.count).toBe(1);
    expect(streakAfter?.code).toBe(CODE_B);

    for (let i = 2; i <= MAX_ERROR_CODE_REPEAT; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      await (inspectWorkflow!.execute as any)(
        { sections: ["instruction"] },
        { toolCallId: `iy${i}`, messages: [] },
      );
      // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
      await (editPatch!.execute as any)(badPlaceholderPatch(i), {
        toolCallId: `tc${i}`,
        messages: [],
      });
      expect(signals.toolErrorCodeRepeat.get("edit_workflow_patch")?.count).toBe(i);
    }
    expect(signals.toolErrorCodeRepeat.get("edit_workflow_patch")?.count).toBe(
      MAX_ERROR_CODE_REPEAT,
    );
    expect(signals.toolErrorCodeRepeat.get("edit_workflow_patch")?.code).toBe(CODE_B);

    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    await (inspectWorkflow!.execute as any)(
      { sections: ["instruction"] },
      { toolCallId: "iw", messages: [] },
    );
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const resultTrip = await (editPatch!.execute as any)(badPlaceholderPatch("trip"), {
      toolCallId: "td1",
      messages: [],
    });
    const tripCode = resultTrip.data?.error_code ?? resultTrip.error_code;
    expect(["tool_error_repeat", "turn_loop_budget_exhausted"]).toContain(tripCode);
  });

  test("ask_user_choice bypasses the breaker even when totalLoopWarnings is high", async () => {
    const signals = freshSignals();
    signals.toolErrorCodeRepeat.set("edit_workflow_patch", {
      code: CODE_A,
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
    const errCode = result.data?.error_code ?? result.error_code;
    expect(errCode).not.toBe("tool_error_repeat");
    expect(errCode).not.toBe("turn_loop_budget_exhausted");
  });

  test("inspect_workflow bypasses the breaker even when streak is at cap", async () => {
    const signals = freshSignals();
    signals.toolErrorCodeRepeat.set("edit_workflow_patch", {
      code: CODE_A,
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
