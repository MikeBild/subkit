// Policy confirm-before-execution integration test.
//
// Regression gate for Gap #1: when `resolveToolMode` returns
// `confirm_before_execution`, sdk-wrap must short-circuit with an
// elicit_request + pause instead of executing the tool. The re-call
// carrying `__policy_confirmed: true` then runs the tool.
//
// This is a unit-level test that drives wrapTools directly against a
// fake inner tool.

import { beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { conversations, conversationToolCalls } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import { getElicitation } from "../elicitations.ts";
import type { ToolContext } from "../tools/index.ts";
import { type TurnSignals, wrapTools } from "../tools/sdk-wrap.ts";
import type { TurnEvent } from "../types.ts";

let ctx: LlmTestCtx;
let conversation_id: string;

beforeAll(async () => {
  ctx = await createLlmTestCtx("policy-confirm");
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  conversation_id = row!.id;
});

describe("policy confirm_before_execution wiring", () => {
  it("run_workflow in prod mode stages an elicit_request and does not execute", async () => {
    const events: TurnEvent[] = [];
    const signals: TurnSignals = {
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

    // run_workflow is registered and gated by run_workflow policy.
    // Invoking with environment=prod triggers confirm_before_execution.
    const runWorkflow = wrapped.run_workflow;
    expect(runWorkflow).toBeDefined();

    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (runWorkflow!.execute as any)(
      {
        workflow_id: "00000000-0000-0000-0000-000000000000",
        environment: "prod",
      },
      { toolCallId: "fake", messages: [] },
    );

    // The wrapper returns pause with elicit_request — the inner tool
    // never ran (so no "workflow_not_found" 404 came back).
    expect(result.ok).toBe(false);
    expect(result.pause).toBeDefined();
    expect(result.pause?.tool_name).toBe("ask_user_confirm");
    expect(result.data).toMatchObject({ pending: true, policy_mode: "confirm_before_execution" });

    // An elicit_request frame landed in the event stream.
    const elicit = events.find((e) => e.type === "elicit_request");
    expect(elicit).toBeDefined();
    if (!elicit || elicit.type !== "elicit_request") {
      throw new Error("expected elicit_request event");
    }
    const elicitation = await getElicitation(ctx.tenant_id, elicit.elicitation_id, ctx.testDb.db);
    expect(elicitation?.tool_name).toBe("ask_user_confirm");
    expect(elicitation?.status).toBe("pending");

    // conversation_tool_calls row carries confirmation_state=proposed
    // with resolved_mode in confirmation_data.
    const [row] = await ctx.testDb.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, conversation_id))
      .limit(1);
    expect(row?.confirmation_state).toBe("proposed");
    const cdata = row?.confirmation_data as { resolved_mode?: string } | null;
    expect(cdata?.resolved_mode).toBe("confirm_before_execution");
  });

  it("run_workflow in dev mode executes immediately (policy resolves to no_confirm)", async () => {
    // Clear the prior tool-call row so this test reads a fresh one.
    const events: TurnEvent[] = [];
    const signals: TurnSignals = {
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

    // dev-mode run — policy resolves to no_confirm, tool executes
    // (and returns workflow_not_found because the id is fake — that's
    // proof the inner tool ran, not the policy gate).
    // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
    const result = await (wrapped.run_workflow!.execute as any)(
      {
        workflow_id: "00000000-0000-0000-0000-000000000001",
        environment: "dev",
      },
      { toolCallId: "fake", messages: [] },
    );
    // Either `ok: false, data.error` or `ok: true`. The critical bit:
    // no pause.
    expect(result.pause).toBeUndefined();
  });
});
