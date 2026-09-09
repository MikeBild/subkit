// Confirm-gate integration test — the ONE deterministic rule end to end.
//
// The pre-execution confirm decision is consulted by BOTH the conversation
// loop gate (`tools/sdk-wrap/invoke.ts`, driven here through `wrapTools`,
// which evaluates `decideConfirm`) and the unified `policyDecide()` every
// dispatcher surface calls.
//
// The rule: reads auto-run; a write under `confirm_before_execution` PAUSES
// unless a durable, engine-verified `priorApproval` is present. Nothing the
// MODEL puts in its own tool call clears the gate — the loop publishes no
// confirm marker on any tool schema, and reads none off the args. This test
// pins that behaviour on the loop surface AND proves the loop and MCP surfaces
// reach the IDENTICAL pause/proceed verdict for the same tool + args.

import { beforeAll, describe, expect, it, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { Db } from "../../db/client.ts";
import { conversations, conversationToolCalls } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import { buildToolAnnotations } from "../../mcp/capabilities/tool-meta.ts";
import { policyDecide } from "../../tools/policy.ts";
import { getElicitation } from "../elicitations.ts";
import {
  APPROVAL_HANDLE_KEY as _APPROVAL_HANDLE_KEY,
  approvalHandleFromElicitationInput,
  withApprovalHandle,
  withoutApprovalHandle,
} from "../tools/ask-user/commit-intent.ts";
import type { ToolContext } from "../tools/index.ts";
import { buildPolicyGateCommitIntent } from "../tools/sdk-wrap/policy-helpers.ts";
import { type TurnSignals, wrapTools } from "../tools/sdk-wrap.ts";
import type { TurnEvent } from "../types.ts";

/** Deterministic handle — random ids are banned in tests. */
const APPROVAL_ID = "00000000-0000-4000-8000-00000000c0de";

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

function toolCtxFor(): ToolContext {
  const engineClient = new EngineClient({
    tenant_id: ctx.tenant_id,
    actor_id: null,
    actor_type: "system",
    db: ctx.testDb.db as unknown as Db,
  });
  return {
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
}

// Drive a single tool through the loop gate (`wrapTools`) and return
// its wrapped-execute result + the emitted event stream.
async function runLoopTool(
  tool: string,
  args: Record<string, unknown>,
): Promise<{ result: { ok: boolean; pause?: unknown; data?: unknown }; events: TurnEvent[] }> {
  const events: TurnEvent[] = [];
  const signals = freshSignals();
  const wrapped = await wrapTools(
    toolCtxFor(),
    signals,
    events,
    ctx.testDb.db as unknown as Db,
    ["workflow-authoring"],
    {},
  );
  const t = wrapped[tool];
  expect(t).toBeDefined();
  // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
  const result = await (t!.execute as any)(args, { toolCallId: "fake", messages: [] });
  return { result, events };
}

describe("confirm gate — loop surface follows the deterministic rule", () => {
  it("an explicit one-shot write in prod PAUSES without human approval", async () => {
    const { result, events } = await runLoopTool("run_workflow", {
      workflow: "render-upload-slides",
      environment: "prod",
      execute_writes: true,
      input: '{"markdown":"# Slides","filename":"slides.html"}',
    });

    // Deterministic pause — the inner tool never ran (no workflow_not_found
    // 404 came back).
    expect(result.ok).toBe(false);
    expect(result.pause).toBeDefined();
    expect((result.pause as { tool_name?: string }).tool_name).toBe("ask_user_confirm");
    expect(result.data).toMatchObject({ pending: true, policy_mode: "confirm_before_execution" });

    const elicit = events.find((e) => e.type === "elicit_request");
    expect(elicit).toBeDefined();
    if (elicit?.type !== "elicit_request") throw new Error("expected elicit_request");
    const elicitation = await getElicitation(ctx.tenant_id, elicit.elicitation_id, ctx.testDb.db);
    expect(elicitation?.tool_name).toBe("ask_user_confirm");
    expect(elicitation?.status).toBe("pending");
    expect(elicit.input).toMatchObject({
      risk_level: "high",
      target_label: "run_workflow: render-upload-slides",
      reversible: true,
      commit_intent: {
        kind: "run_workflow",
        payload: {
          workflow_id: "render-upload-slides",
          workflow_slug: "render-upload-slides",
          input_partial: { markdown: "# Slides", filename: "slides.html" },
        },
      },
    });
    expect(elicit.summary).toBe('Run workflow "render-upload-slides" in prod');

    // MUST-KEEP: the confirmation-state-machine row is staged as proposed.
    const [row] = await ctx.testDb.db
      .select()
      .from(conversationToolCalls)
      .where(eq(conversationToolCalls.conversation_id, conversation_id))
      .limit(1);
    expect(row?.confirmation_state).toBe("proposed");
    const cdata = row?.confirmation_data as { resolved_mode?: string } | null;
    expect(cdata?.resolved_mode).toBe("confirm_before_execution");
  });

  it("run_workflow in dev (no_confirm) executes immediately — no pause", async () => {
    const { result } = await runLoopTool("run_workflow", {
      workflow_id: "00000000-0000-0000-0000-000000000001",
      environment: "dev",
    });
    // The critical bit: no pause. The inner tool ran (and returned a
    // workflow_not_found for the fake id — proof the gate did not swallow it).
    expect(result.pause).toBeUndefined();
  });

  it("an explicit one-shot write with __policy_confirmed still PAUSES (the marker is inert)", async () => {
    const { result } = await runLoopTool("run_workflow", {
      workflow_id: "00000000-0000-0000-0000-000000000002",
      environment: "prod",
      execute_writes: true,
      __policy_confirmed: true,
    });
    // The gate reads no marker off the args. One tool call carrying it must not
    // become a live prod run with no elicitation, no approval row, no human.
    expect(result.ok).toBe(false);
    expect(result.pause).toBeDefined();
    expect((result.pause as { tool_name?: string }).tool_name).toBe("ask_user_confirm");
  });

  it("no wrapped tool ADVERTISES a confirm marker in the schema it publishes", async () => {
    const events: TurnEvent[] = [];
    const wrapped = await wrapTools(
      toolCtxFor(),
      freshSignals(),
      events,
      ctx.testDb.db as unknown as Db,
      ["workflow-authoring"],
      {},
    );
    for (const [name, t] of Object.entries(wrapped)) {
      const schema = (t as { inputSchema?: { shape?: Record<string, unknown> } }).inputSchema;
      const shape = schema?.shape;
      if (!shape) continue;
      expect(`${name}:${"__policy_confirmed" in shape}`).toBe(`${name}:false`);
      expect(`${name}:${"__policy_confirm_id" in shape}`).toBe(`${name}:false`);
    }
  });
});

describe("confirm gate — both surfaces require locally verifiable human approval", () => {
  // The presentation differs (conversation card or approval portal), but
  // neither surface accepts a client annotation as proof of human consent.
  it("one-shot prod writes: chat pauses and MCP requires the same decision", async () => {
    const { result: loop } = await runLoopTool("run_workflow", {
      workflow: "render-upload-slides",
      environment: "prod",
      execute_writes: true,
    });
    const mcp = policyDecide({
      tool: "run_workflow",
      category: "tenant_write",
      surface: "mcp",
      args: { workflow: "render-upload-slides", environment: "prod", execute_writes: true },
    });
    expect(Boolean(loop.pause)).toBe(true);
    expect(mcp.kind).toBe("needs_confirm");
    if (mcp.kind === "needs_confirm") expect(mcp.envelope.resume).toContain("confirm_tool_call");
    expect(buildToolAnnotations("workflow_run", "run_workflow").destructiveHint).toBe(true);
  });

  for (const environment of ["dev", "prod"] as const) {
    it(`ordinary ${environment} workflow starts reach admission on both surfaces`, async () => {
      const { result: loop } = await runLoopTool("run_workflow", {
        workflow_id: "00000000-0000-0000-0000-000000000001",
        environment,
      });
      const mcp = policyDecide({
        tool: "run_workflow",
        category: "tenant_write",
        surface: "mcp",
        args: { environment },
      });
      expect(Boolean(loop.pause)).toBe(false);
      expect(mcp.kind).not.toBe("needs_confirm");
    });
  }

  it("run_workflow dev with execute_writes: both surfaces gate the live request", async () => {
    // `execute_writes:true` is a request for the operator's approval, not an
    // approval. Both surfaces wait for the actual human decision.
    const { result: loop } = await runLoopTool("run_workflow", {
      workflow_id: "00000000-0000-0000-0000-000000000003",
      environment: "dev",
      execute_writes: true,
    });
    const mcp = policyDecide({
      tool: "run_workflow",
      category: "tenant_write",
      surface: "mcp",
      args: { environment: "dev", execute_writes: true },
    });
    expect(Boolean(loop.pause)).toBe(true);
    expect(mcp.kind).toBe("needs_confirm");
    expect(buildToolAnnotations("workflow_run", "run_workflow").destructiveHint).toBe(true);
  });
});

describe("every gated confirm gets a human channel", () => {
  // Production, on claude.ai: `save_workflow_draft` paused with
  // `commit_intent.kind: "save_workflow_draft"`, NO `approval_url` and NO
  // approval handle. On a client that cannot render an in-band form that is not
  // a prompt — it is a dead end, and the only remaining route was an operator
  // hand-running curl against /respond with their API key.
  //
  // A shape-specific carrier must therefore carry a handle exactly like the
  // universal one, so the browser portal can reach it. `withApprovalHandle` is
  // what makes both shapes satisfy the single predicate everything downstream
  // keys on.
  test("a shape-specific carrier keeps its kind AND gains the approval handle", () => {
    const intent = buildPolicyGateCommitIntent("save_workflow_draft", { force_commit: true });
    expect(intent).not.toBeNull();
    expect(intent?.kind).toBe("save_workflow_draft");
    // Before: no handle at all → invisible to the portal, model-resolvable.
    expect(approvalHandleFromElicitationInput({ commit_intent: intent })).toBeNull();

    const withHandle = withApprovalHandle(intent as Record<string, unknown>, APPROVAL_ID);
    // The carrier's own payload survives — the resume still knows it is a save.
    expect(withHandle.kind).toBe("save_workflow_draft");
    expect((withHandle.payload as Record<string, unknown>).force_commit).toBe(true);
    // …and it is now reachable through the portal.
    expect(approvalHandleFromElicitationInput({ commit_intent: withHandle })).toBe(APPROVAL_ID);
  });

  test("the handle never reaches a client projection", () => {
    const intent = withApprovalHandle(
      buildPolicyGateCommitIntent("save_workflow_draft", {}) as Record<string, unknown>,
      APPROVAL_ID,
    );
    const operatorInput = withoutApprovalHandle({
      kind: "save_workflow_draft",
      commit_intent: intent,
    });
    expect(approvalHandleFromElicitationInput(operatorInput)).toBeNull();
    expect(JSON.stringify(operatorInput)).not.toContain(APPROVAL_ID);
  });
});
