// Confirm-gate integration test — the ONE deterministic rule end to end.
//
// The pre-execution confirm decision is a single pure function
// (`decideConfirm`) consulted by BOTH the conversation loop gate
// (`tools/sdk-wrap/invoke.ts`, driven here through `wrapTools`) and the
// MCP-direct gate (`mcp/capabilities/policy-gate.ts#gateTenantToolCall`).
//
// The rule: reads auto-run; a write under `confirm_before_execution`
// PAUSES unless a `policyMarker` (`__policy_confirmed` / `_meta.sk_confirm`)
// or a durable `priorApproval` is present. This test pins that behaviour
// on the loop surface AND proves the loop and MCP-direct surfaces reach
// the IDENTICAL pause/proceed verdict for the same tool + args.

import { beforeAll, describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import type { ResolvedPrincipal } from "../../auth/types.ts";
import type { Db } from "../../db/client.ts";
import { conversations, conversationToolCalls } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import { gateTenantToolCall } from "../../mcp/capabilities/policy-gate.ts";
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

function mkPrincipal(): ResolvedPrincipal {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    tenant_id: ctx.tenant_id,
    kind: "user",
    provider: "api_key",
    email: "admin@test.local",
    role: "admin",
    roles: ["admin"],
    allowed_workflows: "all",
  } as unknown as ResolvedPrincipal;
}

describe("confirm gate — loop surface follows the deterministic rule", () => {
  it("run_workflow in prod (write, no marker/approval) PAUSES and does not execute", async () => {
    const { result, events } = await runLoopTool("run_workflow", {
      workflow: "render-upload-slides",
      environment: "prod",
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
    if (!elicit || elicit.type !== "elicit_request") throw new Error("expected elicit_request");
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

  it("run_workflow in prod WITH __policy_confirmed proceeds past the gate (marker clears it)", async () => {
    const { result } = await runLoopTool("run_workflow", {
      workflow_id: "00000000-0000-0000-0000-000000000002",
      environment: "prod",
      __policy_confirmed: true,
    });
    // policyMarker present → decideConfirm proceeds; the inner tool ran
    // (fake id → not a pause envelope).
    expect(result.pause).toBeUndefined();
  });
});

describe("confirm gate — loop and MCP-direct reach IDENTICAL verdicts", () => {
  // Same (tool, args) evaluated on both surfaces must pause-or-proceed
  // identically. Both consult the single `decideConfirm` rule.
  it("run_workflow prod: loop PAUSES and MCP-direct returns pending", async () => {
    const { result: loop } = await runLoopTool("run_workflow", {
      workflow: "render-upload-slides",
      environment: "prod",
    });
    const mcp = await gateTenantToolCall({
      tool: "run_workflow",
      category: "tenant_write",
      args: { workflow: "render-upload-slides", environment: "prod" },
      meta: undefined,
      principal: mkPrincipal(),
      db: ctx.testDb.db as unknown as Db,
    });
    const loopPaused = Boolean(loop.pause);
    const mcpPaused = mcp.kind === "pending";
    expect(loopPaused).toBe(true);
    expect(mcpPaused).toBe(true);
    expect(loopPaused).toBe(mcpPaused);
  });

  it("run_workflow dev: loop PROCEEDS and MCP-direct proceeds", async () => {
    const { result: loop } = await runLoopTool("run_workflow", {
      workflow_id: "00000000-0000-0000-0000-000000000001",
      environment: "dev",
    });
    const mcp = await gateTenantToolCall({
      tool: "run_workflow",
      category: "tenant_write",
      args: { environment: "dev" },
      meta: undefined,
      principal: mkPrincipal(),
      db: ctx.testDb.db as unknown as Db,
    });
    const loopPaused = Boolean(loop.pause);
    const mcpPaused = mcp.kind === "pending";
    expect(loopPaused).toBe(false);
    expect(mcpPaused).toBe(false);
    expect(loopPaused).toBe(mcpPaused);
  });

  it("run_workflow prod WITH confirmation marker: both surfaces proceed", async () => {
    const { result: loop } = await runLoopTool("run_workflow", {
      workflow_id: "00000000-0000-0000-0000-000000000003",
      environment: "prod",
      __policy_confirmed: true,
    });
    const mcp = await gateTenantToolCall({
      tool: "run_workflow",
      category: "tenant_write",
      args: { environment: "prod" },
      meta: { sk_confirm: true },
      principal: mkPrincipal(),
      db: ctx.testDb.db as unknown as Db,
    });
    const loopPaused = Boolean(loop.pause);
    const mcpPaused = mcp.kind === "pending";
    expect(loopPaused).toBe(false);
    expect(mcpPaused).toBe(false);
    expect(loopPaused).toBe(mcpPaused);
  });
});
