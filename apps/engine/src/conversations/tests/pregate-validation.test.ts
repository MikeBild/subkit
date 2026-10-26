import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import {
  auditLog,
  conversationElicitations,
  conversations,
  knowledgeSources,
  tenants,
  toolApprovals,
} from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import { getTool, type ToolContext } from "../tools/index.ts";
import { wrapOne } from "../tools/sdk-wrap/invoke.ts";
import { checkBeforeGate } from "../tools/sdk-wrap/pregate.ts";
import type { TurnSignals } from "../tools/sdk-wrap.ts";
import type { TurnEvent } from "../types.ts";

let ctx: LlmTestCtx;

beforeAll(async () => {
  ctx = await createLlmTestCtx("pregate");
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

function toolCtxFor(conversation_id: string): ToolContext {
  const db = ctx.testDb.db as unknown as Db;
  return {
    db,
    tenant_id: ctx.tenant_id,
    conversation_id,
    actor_id: null,
    connector_id: null,
    workflow_id: null,
    engineClient: new EngineClient({
      tenant_id: ctx.tenant_id,
      actor_id: null,
      actor_type: "system",
      db,
    }),
    getDraft: () => ({ workflow: { name: "", steps: [] } }),
    setDraft: async () => {},
    surface: "chat",
  };
}

async function callTool(name: string, conversation_id: string, args: Record<string, unknown>) {
  const inner = getTool(name);
  if (!inner) throw new Error(`${name} is not registered`);
  const events: TurnEvent[] = [];
  const wrapped = wrapOne(
    inner,
    toolCtxFor(conversation_id),
    freshSignals(),
    events,
    ctx.testDb.db as unknown as Db,
    {},
    null,
    [],
  );
  // biome-ignore lint/suspicious/noExplicitAny: Tool.execute is generic
  const result = await (wrapped.execute as any)(args, { toolCallId: "fake", messages: [] });
  return { result: result as { ok: boolean; pause?: unknown; data?: unknown }, events };
}

async function callConnector(conversation_id: string, args: Record<string, unknown>) {
  return callTool("call_connector", conversation_id, args);
}

async function elicitationsOf(conversation_id: string) {
  return ctx.testDb.db
    .select()
    .from(conversationElicitations)
    .where(eq(conversationElicitations.conversation_id, conversation_id));
}

async function confirmationAuditsOf(conversation_id: string) {
  return ctx.testDb.db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.tenant_id, ctx.tenant_id),
        eq(auditLog.action, AuditAction.TOOL_POLICY_CONFIRMATION_REQUIRED),
        eq(auditLog.resource_id, conversation_id),
      ),
    );
}

describe("a person is never asked to approve a call that cannot run", () => {
  it("an invented connector id is refused to the model before any approval is opened", async () => {
    const conversation_id = await newConversation();
    const { result, events } = await callConnector(conversation_id, {
      connector_id: "00000000-0000-0000-0000-000000000000",
      method: "PATCH",
      path: "/v1/workflows/one",
      body: { name: "changed" },
    });

    expect(result.ok).toBe(false);
    expect(result.pause).toBeUndefined();
    expect(result.data).toMatchObject({ error: { code: "connector_not_found" } });
    expect(events.some((event) => event.type === "elicit_request")).toBe(false);
    expect(await elicitationsOf(conversation_id)).toHaveLength(0);
    expect(await confirmationAuditsOf(conversation_id)).toHaveLength(0);
    const approvals = await ctx.testDb.db
      .select()
      .from(toolApprovals)
      .where(eq(toolApprovals.tenant_id, ctx.tenant_id));
    expect(approvals).toHaveLength(0);
  });

  it("arguments the connector's driver cannot take are refused before the gate", async () => {
    const conversation_id = await newConversation();
    const { result } = await callConnector(conversation_id, {
      connector_id: ctx.connector_id,
      method: "POST",
      path: "/users",
      sql: "DELETE FROM users",
    });

    expect(result.ok).toBe(false);
    expect(result.pause).toBeUndefined();
    expect(result.data).toMatchObject({ error: { code: "invalid_input" } });
    expect(await elicitationsOf(conversation_id)).toHaveLength(0);
  });

  it("a call that can run still waits for the person, and the question names its effect", async () => {
    const conversation_id = await newConversation();
    const { result, events } = await callConnector(conversation_id, {
      connector_id: ctx.connector_id,
      method: "POST",
      path: "/users",
      body: { name: "Ada" },
    });

    expect(result.ok).toBe(false);
    expect(result.pause).toBeDefined();
    const [elicitation] = await elicitationsOf(conversation_id);
    expect(elicitation?.status).toBe("pending");
    const input = elicitation?.input as Record<string, unknown>;
    expect(input.effect).toEqual({
      connector: "API pregate",
      method: "POST",
      target: "https://jsonplaceholder.typicode.com/users",
    });
    expect(input.question).toBe(
      "API pregate: POST https://jsonplaceholder.typicode.com/users — approve this call?",
    );
    expect(String(input.question)).not.toContain("call_connector");
    expect(elicitation?.summary).toBe(
      "API pregate: POST https://jsonplaceholder.typicode.com/users",
    );
    expect(events.some((event) => event.type === "elicit_request")).toBe(true);
    expect(await confirmationAuditsOf(conversation_id)).toHaveLength(1);
  });

  it("a secret the model put into the path never reaches the question", async () => {
    const conversation_id = await newConversation();
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    await callConnector(conversation_id, {
      connector_id: ctx.connector_id,
      method: "POST",
      path: `/users/${token}`,
      body: { name: "Ada" },
    });
    const [elicitation] = await elicitationsOf(conversation_id);
    const input = elicitation?.input as { question: string; effect: { target: string } };
    for (const text of [input.question, input.effect.target, elicitation?.summary ?? ""])
      expect(text).not.toContain(token);
  });

  it("deleting a workflow id that does not exist is refused before any approval", async () => {
    const conversation_id = await newConversation();
    const { result, events } = await callTool("delete_workflow", conversation_id, {
      id: "2a9e7c1d-5b3f-4c8e-9d2a-1f0e3b4c5d6e",
    });

    expect(result.ok).toBe(false);
    expect(result.pause).toBeUndefined();
    expect(result.data).toMatchObject({ error: { code: "workflow_not_found" } });
    expect(events.some((event) => event.type === "elicit_request")).toBe(false);
    expect(await elicitationsOf(conversation_id)).toHaveLength(0);
    expect(await confirmationAuditsOf(conversation_id)).toHaveLength(0);
  });

  it("deleting a workflow slug that names nothing is refused before any approval", async () => {
    const conversation_id = await newConversation();
    const { result } = await callTool("delete_workflow", conversation_id, {
      slug: "no-such-workflow",
    });

    expect(result.ok).toBe(false);
    expect(result.pause).toBeUndefined();
    expect(result.data).toMatchObject({ error: { code: "workflow_not_found" } });
    expect(await elicitationsOf(conversation_id)).toHaveLength(0);
  });
});

async function seedKnowledgeSource(tenant_id: string, label: string): Promise<string> {
  const [row] = await ctx.testDb.db
    .insert(knowledgeSources)
    .values({
      tenant_id,
      name: `Source ${label}`,
      slug: `source-${label}`,
      source_type: "file_upload",
      source_uri: `${label}.md`,
      version: "v1",
    })
    .returning({ id: knowledgeSources.id });
  if (!row) throw new Error("seed knowledge source failed");
  return row.id;
}

function paletteCtx(options: { intakeReview: boolean; tools?: string[] }): ToolContext {
  return {
    ...toolCtxFor("20000000-0000-4000-8000-000000000001"),
    getDraft: () =>
      ({
        workflow: { name: "", steps: [] },
        ...(options.intakeReview
          ? { session: { intake_item_ids: ["10000000-0000-4000-8000-000000000001"] } }
          : {}),
      }) as never,
    ...(options.tools ? { availableToolNames: new Set(options.tools) } : {}),
  };
}

async function precheck(tool: string, toolCtx: ToolContext, args: Record<string, unknown>) {
  const inner = getTool(tool);
  if (!inner) throw new Error(`${tool} is not registered`);
  const result = await checkBeforeGate(inner, toolCtx, args);
  if (result.ok) throw new Error("expected a refusal");
  return result.result as {
    ok: false;
    error_code?: string;
    message?: string;
    data?: Record<string, unknown>;
    next_best_actions?: string[];
  };
}

describe("an id of another resource type names the right tool", () => {
  it("a knowledge source id passed to update_connector points to the knowledge tools", async () => {
    const id = await seedKnowledgeSource(ctx.tenant_id, "cross-type");
    const refusal = await precheck(
      "update_connector",
      paletteCtx({
        intakeReview: false,
        tools: ["update_connector", "update_knowledge_source", "get_knowledge_source"],
      }),
      { id, description: "changed" },
    );
    expect(refusal.error_code).toBe("connector_not_found");
    expect(refusal.data).toMatchObject({ actual_resource_type: "knowledge_source" });
    expect(refusal.message).toContain("existing knowledge source");
    expect(refusal.message).toContain("update_knowledge_source");
    expect(refusal.next_best_actions).toEqual(["update_knowledge_source", "get_knowledge_source"]);
  });

  it("in an intake review the removed edit tool is replaced by the normal-chat handoff", async () => {
    const id = await seedKnowledgeSource(ctx.tenant_id, "intake-review");
    const refusal = await precheck(
      "update_connector",
      paletteCtx({
        intakeReview: true,
        tools: ["update_connector", "update_knowledge_source", "get_knowledge_source"],
      }),
      { id, description: "changed" },
    );
    expect(refusal.data).toMatchObject({ actual_resource_type: "knowledge_source" });
    expect(refusal.message).toContain("Use get_knowledge_source for this knowledge source.");
    expect(refusal.message).toContain("normal chat");
    expect(refusal.next_best_actions).toEqual(["get_knowledge_source"]);
  });

  it("a tool missing from the palette is never offered", async () => {
    const id = await seedKnowledgeSource(ctx.tenant_id, "no-palette");
    const refusal = await precheck(
      "update_workflow",
      paletteCtx({ intakeReview: false, tools: ["update_workflow"] }),
      { id, description: "changed" },
    );
    expect(refusal.error_code).toBe("workflow_not_found");
    expect(refusal.message).toContain("No knowledge source tool for this id is available");
    expect(refusal.next_best_actions).toBeUndefined();
  });

  it("an unknown palette names the resource type without claiming a tool is missing", async () => {
    const id = await seedKnowledgeSource(ctx.tenant_id, "unknown-palette");
    const refusal = await precheck("update_connector", paletteCtx({ intakeReview: false }), {
      id,
      description: "changed",
    });
    expect(refusal.data).toMatchObject({ actual_resource_type: "knowledge_source" });
    expect(refusal.message).toContain("Use a knowledge source tool for this id instead.");
    expect(refusal.message).not.toContain("is available in this conversation");
  });

  it("an invented id in an intake review gets the generic refusal and the handoff", async () => {
    const refusal = await precheck(
      "update_workflow",
      paletteCtx({ intakeReview: true, tools: ["update_workflow"] }),
      { id: "00000000-0000-0000-0000-000000000000", description: "changed" },
    );
    expect(refusal.error_code).toBe("workflow_not_found");
    expect(refusal.data?.actual_resource_type).toBeUndefined();
    expect(refusal.message).toContain("normal chat");
  });

  it("a resource type the principal may not read is not revealed", async () => {
    const enduser = (): ToolContext => ({
      ...paletteCtx({ intakeReview: false, tools: ["get_skill", "get_connector"] }),
      principal: {
        provider: "conversation_tool",
        kind: "user",
        id: "20000000-0000-4000-8000-000000000002",
        tenant_id: ctx.tenant_id,
        roles: ["enduser"],
      },
    });
    const hidden = await precheck("get_skill", enduser(), { id: ctx.connector_id });
    expect(hidden.error_code).toBe("skill_not_found");
    expect(hidden.data?.actual_resource_type).toBeUndefined();
    expect(hidden.message).not.toContain("connector");
    const readable = await seedKnowledgeSource(ctx.tenant_id, "enduser-readable");
    const shown = await precheck("get_skill", enduser(), { id: readable });
    expect(shown.error_code).toBe("skill_not_found");
    expect(shown.data).toMatchObject({ actual_resource_type: "knowledge_source" });
  });

  it("a knowledge source of another tenant is not revealed", async () => {
    const [other] = await ctx.testDb.db
      .insert(tenants)
      .values({ slug: "t-pregate-other", display_name: "Other tenant" })
      .returning({ id: tenants.id });
    if (!other) throw new Error("seed tenant failed");
    const foreign = await seedKnowledgeSource(other.id, "foreign");
    const refusal = await precheck(
      "update_connector",
      paletteCtx({ intakeReview: false, tools: ["update_knowledge_source"] }),
      { id: foreign, description: "changed" },
    );
    expect(refusal.error_code).toBe("connector_not_found");
    expect(refusal.data?.actual_resource_type).toBeUndefined();
    expect(refusal.message).not.toContain("knowledge source");
  });
});
