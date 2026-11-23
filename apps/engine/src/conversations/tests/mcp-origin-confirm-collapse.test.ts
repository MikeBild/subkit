import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import {
  auditLog,
  conversationElicitations,
  conversations,
  workflows,
} from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import { policyDecide } from "../../tools/policy.ts";
import { getTool, listTools, type ToolContext } from "../tools/index.ts";
import { wrapOne } from "../tools/sdk-wrap/invoke.ts";
import { wrapTools } from "../tools/sdk-wrap.ts";
import type { TurnEvent } from "../types.ts";
import { freshSignals } from "./turn-signals.ts";

let ctx: LlmTestCtx;

beforeAll(async () => {
  ctx = await createLlmTestCtx("mcp-collapse");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function newConversation(): Promise<string> {
  const [row] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  if (!row) throw new Error("seed conversation failed");
  return row.id;
}

function toolCtxFor(
  conversation_id: string,
  surface: ToolContext["surface"],
  askBeforeWriting = false,
): ToolContext {
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
    ...(askBeforeWriting ? { ask_before_writing: true } : {}),
    engineClient,
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
    ...(surface !== undefined ? { surface } : {}),
  };
}

async function runGatedTool(
  conversation_id: string,
  surface: ToolContext["surface"],
  tool: string,
  args: Record<string, unknown>,
  askBeforeWriting = false,
): Promise<{ result: { ok: boolean; pause?: unknown; data?: unknown }; events: TurnEvent[] }> {
  const inner = getTool(tool);
  expect(inner).toBeDefined();
  if (!inner) throw new Error(`tool ${tool} not registered`);
  const events: TurnEvent[] = [];
  const wrapped = wrapOne(
    inner,
    toolCtxFor(conversation_id, surface, askBeforeWriting),
    freshSignals(),
    events,
    ctx.testDb.db as unknown as Db,
    {},
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

describe("conversation confirmation — no transport bypass", () => {
  it("create_knowledge_source over MCP pauses when the person asks before writing", async () => {
    const conversation_id = await newConversation();
    const { result, events } = await runGatedTool(
      conversation_id,
      "mcp",
      "create_knowledge_source",
      { mode: "inline", name: "Pending source", content: "# Pending" },
      true,
    );
    expect(result.ok).toBe(false);
    expect(result.pause).toBeDefined();
    expect(result.data).not.toMatchObject({ collected: true });
    expect(events.find((event) => event.type === "elicit_request")).toBeDefined();
    expect(await pendingElicitations(conversation_id)).toHaveLength(1);
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

  for (const surface of ["mcp", "chat"] as const) {
    it(`preparation collects an item for review without an approval over ${surface}`, async () => {
      const conversation_id = await newConversation();
      const { result, events } = await runGatedTool(
        conversation_id,
        surface,
        "create_knowledge_source",
        { mode: "inline", name: `Auto source ${surface}`, content: "# Preparation" },
      );
      expect(result.ok).toBe(true);
      expect(result.pause).toBeUndefined();
      expect(result.data).toMatchObject({ collected: true, admitted: false });
      expect(events.find((event) => event.type === "elicit_request")).toBeUndefined();
      expect(await pendingElicitations(conversation_id)).toHaveLength(0);
    });
  }

  it("delete_workflow over mcp still PAUSES on a pending ask_user_confirm", async () => {
    const conversation_id = await newConversation();
    const [workflow] = await ctx.testDb.db
      .insert(workflows)
      .values({
        tenant_id: ctx.tenant_id,
        slug: "collapse-delete-target",
        name: "Delete target",
        lifecycle: "active",
      })
      .returning({ id: workflows.id });
    if (!workflow) throw new Error("seed workflow failed");
    const { result, events } = await runGatedTool(conversation_id, "mcp", "delete_workflow", {
      id: workflow.id,
    });

    expect(result.ok).toBe(false);
    expect(result.pause).toBeDefined();
    expect((result.pause as { tool_name?: string }).tool_name).toBe("ask_user_confirm");
    expect(events.find((e) => e.type === "elicit_request")).toBeDefined();

    const pending = await pendingElicitations(conversation_id);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.tool_name).toBe("ask_user_confirm");

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
});

describe("invariant — every palette tool respects its resolved confirmation", () => {
  it("catalogue category and MCP transport never substitute for approval", () => {
    for (const entry of listTools()) {
      const overrides = { [entry.name]: "confirm_before_execution" as const };
      expect(
        policyDecide({
          tool: entry.name,
          category: entry.category,
          surface: "chat",
          args: {},
          overrides,
        }),
      ).toMatchObject({ kind: "needs_confirm" });
      if (entry.category !== "draft_write") {
        expect(
          policyDecide({
            tool: entry.name,
            category: entry.category,
            surface: "mcp",
            args: {},
            overrides,
          }),
        ).toMatchObject({ kind: "needs_confirm" });
      }
    }
  });

  it("the policy boundary is wired into the full authoring palette", async () => {
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
