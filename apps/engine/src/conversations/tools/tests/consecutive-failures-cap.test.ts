import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "../../../db/client.ts";
import { conversations } from "../../../db/schema/index.ts";
import { EngineClient } from "../../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../../llm/tests/setup.ts";
import type { TurnEvent } from "../../types.ts";
import type { ToolContext } from "../index.ts";
import {
  MAX_CONSECUTIVE_FAILURES,
  MAX_TURN_LOOP_WARNINGS,
  type TurnSignals,
  wrapTools,
} from "../sdk-wrap.ts";

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
    toolErrorCodeRepeat: new Map(),
    totalLoopWarnings: 0,
    consecutiveFailures: 0,
    lastAssistantText: "",
    lastExecutionSuccess: null,
  };
}

describe("consecutive-failures cap", () => {
  test("MAX_CONSECUTIVE_FAILURES is 5", () => {
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
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (editPatch!.execute as any)(
      { patches: [{ op: "replace", path: "/steps/0/method", value: "POST" }] },
      { toolCallId: "t1", messages: [] },
    );
    expect(result.data?.error_code ?? result.error_code).toBe("consecutive_failures_cap");
    expect(result.data?.next_best_actions ?? result.next_best_actions).toContain("ask_user_choice");
  });

  test("cap participates in the turn-loop budget — exhausting it ends the turn", async () => {
    const signals = freshSignals();
    signals.consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
    signals.totalLoopWarnings = MAX_TURN_LOOP_WARNINGS - 1;
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
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (editPatch!.execute as any)(
      { patches: [{ op: "replace", path: "/steps/0/method", value: "POST" }] },
      { toolCallId: "t1", messages: [] },
    );
    expect(result.data?.error_code ?? result.error_code).toBe("turn_loop_budget_exhausted");
    expect(result.data?.reason).toBe("turn_loop_budget_exhausted");
    expect(signals.totalLoopWarnings).toBe(MAX_TURN_LOOP_WARNINGS);
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
        question: "Pick one",
        options: [
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ],
      },
      { toolCallId: "t1", messages: [] },
    );
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
      { toolCallId: "t1", messages: [] },
    );
    expect(result.data?.error_code ?? result.error_code).not.toBe("consecutive_failures_cap");
  });
});
