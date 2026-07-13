// MCP-origin confirm collapse — the enumerated write-tool gate, end to end.
//
// A conversation turn submitted over MCP runs with `surface: "mcp"` on the
// `ToolContext`. The inner confirm gate (`decideConfirm`) collapses the
// server pause for the ENUMERATED additive/reversible write tools only:
// the MCP client's destructiveHint dialog on the outer `conversation_*`
// call was the human gate, and a server pause on this path mints an
// approval no human can reach. Destructive tools keep pausing.
//
// This suite drives the real loop gate (`wrapOne`, the same wrapper
// `wrapTools` installs for every turn) with a mock LLM test context and
// pins:
//   - mcp + create_knowledge_source → EXECUTES: tool output present, no
//     elicitation row, conversation stays active, and the
//     tool_policy.confirm_collapsed_mcp audit row lands.
//   - mcp + delete_workflow → PAUSES: pending ask_user_confirm elicitation.
//   - chat + create_knowledge_source → PAUSES exactly like before.
//   - INVARIANT: every confirm-capable tool in the conversation palette is
//     classified in exactly one of MCP_TURN_COLLAPSIBLE_WRITE_TOOLS /
//     MCP_TURN_KEEP_PAUSE_WRITE_TOOLS — an unclassified new tool fails here.

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import { auditLog, conversationElicitations, conversations } from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import {
  MCP_TURN_COLLAPSIBLE_WRITE_TOOLS,
  MCP_TURN_KEEP_PAUSE_WRITE_TOOLS,
  TOOL_POLICIES,
} from "../tool-policies.ts";
import { getTool, listTools, type ToolContext } from "../tools/index.ts";
import { wrapOne } from "../tools/sdk-wrap/invoke.ts";
import { type TurnSignals, wrapTools } from "../tools/sdk-wrap.ts";
import type { TurnEvent } from "../types.ts";

let ctx: LlmTestCtx;

beforeAll(async () => {
  ctx = await createLlmTestCtx("mcp-collapse");
});

afterAll(async () => {
  await ctx.cleanup();
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

async function newConversation(): Promise<string> {
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  if (!row) throw new Error("seed conversation failed");
  return row.id;
}

function toolCtxFor(conversation_id: string, surface: ToolContext["surface"]): ToolContext {
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
    ...(surface !== undefined ? { surface } : {}),
  };
}

// Drive a single tool through the SAME per-tool wrapper `wrapTools`
// installs for a turn on the given surface, and return the wrapped
// execute result + emitted events.
async function runGatedTool(
  conversation_id: string,
  surface: ToolContext["surface"],
  tool: string,
  args: Record<string, unknown>,
): Promise<{ result: { ok: boolean; pause?: unknown; data?: unknown }; events: TurnEvent[] }> {
  const inner = getTool(tool);
  expect(inner).toBeDefined();
  if (!inner) throw new Error(`tool ${tool} not registered`);
  const events: TurnEvent[] = [];
  const wrapped = wrapOne(
    inner,
    toolCtxFor(conversation_id, surface),
    freshSignals(),
    events,
    ctx.testDb.db as unknown as Db,
    {},
    null,
    [],
  );
  // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
  const result = await (wrapped.execute as any)(args, { toolCallId: "fake", messages: [] });
  return { result, events };
}

async function pendingElicitations(conversation_id: string) {
  return await ctx.testDb.db
    .select()
    .from(conversationElicitations)
    .where(
      and(
        eq(conversationElicitations.conversation_id, conversation_id),
        eq(conversationElicitations.status, "pending"),
      ),
    );
}

describe("mcp-origin turn — enumerated collapse executes the write", () => {
  it("create_knowledge_source over mcp EXECUTES: output present, no elicitation, collapse audit row", async () => {
    const conversation_id = await newConversation();
    const { result, events } = await runGatedTool(
      conversation_id,
      "mcp",
      "create_knowledge_source",
      {
        mode: "inline",
        name: "MCP Collapse Probe",
        content: "# Probe\n\nA small inline knowledge source used to pin the MCP collapse gate.",
      },
    );

    // The gate collapsed — no pause envelope, the inner tool RAN and its
    // output is present on the tool result.
    expect(result.pause).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ created: true });
    expect(events.find((e) => e.type === "elicit_request")).toBeUndefined();

    // No elicitation row was minted, and the conversation stayed active.
    expect(await pendingElicitations(conversation_id)).toHaveLength(0);
    const [conv] = await ctx.testDb.db
      .select({ status: conversations.status })
      .from(conversations)
      .where(eq(conversations.id, conversation_id));
    expect(conv?.status).toBe("active");

    // The durable collapse trail: tool_policy.confirm_collapsed_mcp.
    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.action, AuditAction.TOOL_POLICY_CONFIRM_COLLAPSED_MCP),
          eq(auditLog.resource_id, conversation_id),
        ),
      );
    expect(audits).toHaveLength(1);
    expect(audits[0]?.result).toBe("success");
    expect(audits[0]?.reason).toBe("mcp_client_dialog_gate");
    expect(audits[0]?.metadata).toMatchObject({
      tool: "create_knowledge_source",
      mode: "confirm_before_execution",
      gate: "mcp_client_destructive_hint_dialog",
    });
  });

  it("delete_workflow over mcp still PAUSES on a pending ask_user_confirm", async () => {
    const conversation_id = await newConversation();
    const { result, events } = await runGatedTool(conversation_id, "mcp", "delete_workflow", {
      id: "00000000-0000-0000-0000-000000000001",
    });

    expect(result.ok).toBe(false);
    expect(result.pause).toBeDefined();
    expect((result.pause as { tool_name?: string }).tool_name).toBe("ask_user_confirm");
    expect(events.find((e) => e.type === "elicit_request")).toBeDefined();

    const pending = await pendingElicitations(conversation_id);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.tool_name).toBe("ask_user_confirm");

    // No collapse audit row for a kept pause.
    const audits = await ctx.testDb.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, ctx.tenant_id),
          eq(auditLog.action, AuditAction.TOOL_POLICY_CONFIRM_COLLAPSED_MCP),
          eq(auditLog.resource_id, conversation_id),
        ),
      );
    expect(audits).toHaveLength(0);
  });

  it("control: create_knowledge_source over chat PAUSES like today", async () => {
    const conversation_id = await newConversation();
    const { result } = await runGatedTool(conversation_id, "chat", "create_knowledge_source", {
      mode: "inline",
      name: "Chat Control Probe",
      content: "# Control\n\nThe chat surface must still pause this write.",
    });

    expect(result.ok).toBe(false);
    expect(result.pause).toBeDefined();
    expect((result.pause as { tool_name?: string }).tool_name).toBe("ask_user_confirm");
    expect(await pendingElicitations(conversation_id)).toHaveLength(1);
  });
});

describe("invariant — every confirm-capable palette tool is classified", () => {
  // A tool can resolve to confirm_before_execution when its category
  // defaults there (tenant_write), its per-tool default pins it, or a
  // computeModeFromInput hook can upgrade it. Every such tool MUST be in
  // exactly one of the two MCP-collapse sets — fail-closed: adding a new
  // confirm-capable write tool without classifying it fails this test.
  function isConfirmCapable(name: string, category: string): boolean {
    if (category === "tenant_write") return true;
    const def = TOOL_POLICIES[name];
    if (!def) return false;
    if (def.defaultMode === "confirm_before_execution") return true;
    return typeof def.computeModeFromInput === "function";
  }

  it("classifies every confirm-capable tool in exactly one set", () => {
    for (const tool of listTools()) {
      if (!isConfirmCapable(tool.name, tool.category)) continue;
      const collapsible = MCP_TURN_COLLAPSIBLE_WRITE_TOOLS.has(tool.name);
      const keepPause = MCP_TURN_KEEP_PAUSE_WRITE_TOOLS.has(tool.name);
      // Exactly one — neither (unclassified) and both (contradictory)
      // each fail with the offending tool named.
      expect(`${tool.name}: collapsible=${collapsible} keep_pause=${keepPause}`).toBe(
        `${tool.name}: collapsible=${collapsible} keep_pause=${!collapsible}`,
      );
      expect(collapsible || keepPause).toBe(true);
    }
  });

  it("both sets contain only real palette tool names", () => {
    const palette = new Set(listTools().map((t) => t.name));
    for (const name of MCP_TURN_COLLAPSIBLE_WRITE_TOOLS) {
      expect(`${name}: ${palette.has(name)}`).toBe(`${name}: true`);
    }
    for (const name of MCP_TURN_KEEP_PAUSE_WRITE_TOOLS) {
      expect(`${name}: ${palette.has(name)}`).toBe(`${name}: true`);
    }
  });

  it("the sets are disjoint", () => {
    for (const name of MCP_TURN_COLLAPSIBLE_WRITE_TOOLS) {
      expect(MCP_TURN_KEEP_PAUSE_WRITE_TOOLS.has(name)).toBe(false);
    }
  });

  it("the collapsed gate is reachable through the full wrapTools palette (not just wrapOne)", async () => {
    // Sanity: the enumerated tools are actually part of the assembled
    // authoring palette an MCP-origin turn wraps — a collapse set naming
    // tools the palette never exposes would be dead configuration.
    const conversation_id = await newConversation();
    const wrapped = await wrapTools(
      toolCtxFor(conversation_id, "mcp"),
      freshSignals(),
      [],
      ctx.testDb.db as unknown as Db,
      ["workflow-authoring"],
      {},
    );
    expect(wrapped.run_workflow).toBeDefined();
    expect(wrapped.create_knowledge_source).toBeDefined();
  });
});
