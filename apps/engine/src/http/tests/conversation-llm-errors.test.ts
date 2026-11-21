import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  conversationElicitations,
  conversationMessages,
  conversations,
  llmUsage,
  tenants,
} from "../../db/schema/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { testEnv } from "../../test-helpers/determinism/env.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;

beforeAll(async () => {
  testEnv.LLM_PROVIDER = "mock";
  resetMockProvider();
  srv = await createHttpTestServer("conversation-llm-errors");
  await srv.db
    .update(tenants)
    .set({ llm_primary: "conv-quota-primary", llm_fallback: "conv-quota-fallback" })
    .where(eq(tenants.id, srv.tenantId));
});

afterAll(async () => {
  await srv.cleanup();
});

describe("POST /v1/conversations provider-limit handling", () => {
  test("returns 429 llm_provider_quota_exhausted instead of a generic 500", async () => {
    resetMockProvider();
    getMockProvider().setFailure("conv-quota-primary", "quota_exhausted");

    const res = await fetch(`${srv.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${srv.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        initial_message: "hello",
      }),
    });
    expect(res.status).toBe(429);
    const body = (await res.json()) as {
      code: string;
      message: string;
      trace_id: string;
      details?: { retry_at?: string };
    };
    expect(body.code).toBe("llm_provider_quota_exhausted");
    expect(body.trace_id).toMatch(/^cli-|^req-|^[a-z0-9-]+$/i);
    expect(body.details?.retry_at).toBe("2026-05-01T00:00:00.000Z");

    const usageRows = await srv.db
      .select()
      .from(llmUsage)
      .where(eq(llmUsage.tenant_id, srv.tenantId));
    expect(
      usageRows.some((row) => row.model === "conv-quota-primary" && row.result === "error"),
    ).toBe(true);
    expect(
      usageRows.some((row) => row.model === "conv-quota-fallback" && row.result === "success"),
    ).toBe(false);
  });

  test("a streamed first turn that hits the quota is typed and kept on the conversation", async () => {
    resetMockProvider();
    getMockProvider().setFailure("conv-quota-primary", "quota_exhausted");

    const res = await fetch(`${srv.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${srv.apiKey}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify({ initial_message: "hello over the stream" }),
    });
    expect(res.status).toBe(200);
    const frames = (await res.text())
      .split(/\n\n/)
      .map((frame) => ({
        event: frame.match(/^event:\s*(.+)$/m)?.[1]?.trim(),
        data: frame.match(/^data:\s*(.+)$/m)?.[1],
      }))
      .filter((frame) => frame.event && frame.data);
    const started = frames.find((frame) => frame.event === "conversation_started");
    const error = frames.find((frame) => frame.event === "error");
    const conversationId = (JSON.parse(started?.data ?? "{}") as { conversation?: { id: string } })
      .conversation?.id;
    expect(conversationId).toBeString();
    expect(JSON.parse(error?.data ?? "{}")).toMatchObject({
      code: "llm_provider_quota_exhausted",
      details: { kind: "quota_exhausted", retry_at: "2026-05-01T00:00:00.000Z" },
    });

    const [row] = await srv.db
      .select({ last_turn_error: conversations.last_turn_error })
      .from(conversations)
      .where(eq(conversations.id, conversationId ?? ""));
    expect(row?.last_turn_error).toMatchObject({
      code: "llm_provider_quota_exhausted",
      kind: "quota_exhausted",
      retry_at: "2026-05-01T00:00:00.000Z",
    });

    const refused = await srv.db
      .select()
      .from(llmUsage)
      .where(eq(llmUsage.conversation_id, conversationId ?? ""));
    expect(refused.length).toBeGreaterThanOrEqual(1);
    for (const usageRow of refused) {
      expect(usageRow.result).toBe("error");
      expect(usageRow.prompt_tokens).toBe(0);
      expect(usageRow.total_tokens).toBe(0);
    }
    const detail = await fetch(`${srv.baseUrl}/v1/conversations/${conversationId}`, {
      headers: { Authorization: `Bearer ${srv.apiKey}` },
    });
    expect(detail.status).toBe(200);
    const { usage } = (await detail.json()) as {
      usage: { tokens: number; cost: { amount: number } | null };
    };
    expect(usage.tokens).toBe(0);
    expect(usage.cost?.amount ?? 0).toBe(0);
  });

  test("a turn resumed by an answer that hits the quota is typed and kept too", async () => {
    const [conversation] = await srv.db
      .insert(conversations)
      .values({ tenant_id: srv.tenantId, owner_id: srv.userId, status: "awaiting_input" })
      .returning();
    if (!conversation) throw new Error("failed to seed conversation");
    await srv.db.insert(conversationMessages).values({
      tenant_id: srv.tenantId,
      conversation_id: conversation.id,
      role: "user",
      content: { text: "set up the storage connector" },
    });
    const [elicitation] = await srv.db
      .insert(conversationElicitations)
      .values({
        tenant_id: srv.tenantId,
        conversation_id: conversation.id,
        tool_call_id: null,
        tool_name: "ask_user_text",
        summary: "Which region?",
        input: { question: "Which region?" },
        status: "pending",
      })
      .returning();
    if (!elicitation) throw new Error("failed to seed elicitation");
    resetMockProvider();
    getMockProvider().setFailure("conv-quota-primary", "quota_exhausted");

    const res = await fetch(
      `${srv.baseUrl}/v1/conversations/${conversation.id}/elicitations/${elicitation.id}/respond`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${srv.apiKey}`,
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        body: JSON.stringify({ output: { value: "eu-central" } }),
      },
    );
    expect(res.status).toBe(200);
    const errorData = (await res.text()).match(/event: error\ndata: (.+)/)?.[1];
    expect(JSON.parse(errorData ?? "{}")).toMatchObject({
      code: "llm_provider_quota_exhausted",
      details: { kind: "quota_exhausted" },
    });
    const [row] = await srv.db
      .select({ last_turn_error: conversations.last_turn_error })
      .from(conversations)
      .where(eq(conversations.id, conversation.id));
    expect(row?.last_turn_error).toMatchObject({ code: "llm_provider_quota_exhausted" });
  });

  test("an answer the mock provider wrote is labelled as the mock's, not as the route's model", async () => {
    resetMockProvider();
    const res = await fetch(`${srv.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${srv.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ initial_message: "say hello" }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { conversation: { id: string } };
    const rows = await srv.db
      .select({ role: conversationMessages.role, model: conversationMessages.model })
      .from(conversationMessages)
      .where(eq(conversationMessages.conversation_id, body.conversation.id));
    const answers = rows.filter((row) => row.role === "assistant");
    expect(answers.length).toBeGreaterThan(0);
    for (const answer of answers) expect(answer.model).toBe("mock:conv-quota-primary");
  });

  test("returns 409 when a conversation already has pending user input", async () => {
    const [conversation] = await srv.db
      .insert(conversations)
      .values({
        tenant_id: srv.tenantId,
        owner_id: srv.userId,
        status: "awaiting_input",
      })
      .returning();
    if (!conversation) throw new Error("failed to seed conversation");

    const [elicitation] = await srv.db
      .insert(conversationElicitations)
      .values({
        tenant_id: srv.tenantId,
        conversation_id: conversation.id,
        tool_call_id: null,
        tool_name: "ask_user_form",
        summary: "Provide your DigitalOcean API token",
        input: {
          title: "DigitalOcean credential",
          fields: [{ key: "token", label: "Token", type: "password" }],
        },
        status: "pending",
      })
      .returning();
    if (!elicitation) throw new Error("failed to seed elicitation");

    const res = await fetch(`${srv.baseUrl}/v1/conversations/${conversation.id}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${srv.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: "now nothing happens",
      }),
    });
    expect(res.status).toBe(409);
    const body = (await res.json()) as {
      code: string;
      message: string;
      details?: {
        conversation_status?: string;
        pending_elicitation?: {
          id?: string;
          tool_name?: string;
          summary?: string;
          tool_call_id?: string | null;
          input?: unknown;
        };
      };
    };
    expect(body.code).toBe("pending_elicitation_blocked");
    expect(body.message).toContain("resolve the pending dialog");
    expect(body.details?.conversation_status).toBe("awaiting_input");
    expect(body.details?.pending_elicitation).toEqual({
      id: elicitation.id,
      tool_name: "ask_user_form",
      summary: "Provide your DigitalOcean API token",
      tool_call_id: null,
      input: {
        title: "DigitalOcean credential",
        fields: [{ key: "token", label: "Token", type: "password" }],
      },
    });
  });
});
