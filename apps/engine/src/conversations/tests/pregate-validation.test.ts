import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { AuditAction } from "../../audit/types.ts";
import type { Db } from "../../db/client.ts";
import {
  auditLog,
  conversationElicitations,
  conversations,
  toolApprovals,
} from "../../db/schema/index.ts";
import { EngineClient } from "../../engine-client/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import { getTool, type ToolContext } from "../tools/index.ts";
import { wrapOne } from "../tools/sdk-wrap/invoke.ts";
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
