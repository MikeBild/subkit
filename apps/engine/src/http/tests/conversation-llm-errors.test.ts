import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  conversationElicitations,
  conversations,
  llmUsage,
  tenantLlmSettings,
} from "../../db/schema/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();
  srv = await createHttpTestServer("conversation-llm-errors");
  const [settings] = await srv.db
    .insert(tenantLlmSettings)
    .values({
      tenant_id: srv.tenantId,
      llm_provider: "mock",
      llm_primary_model: "conv-quota-primary",
      llm_fallback_model: "conv-quota-fallback",
    })
    .onConflictDoUpdate({
      target: tenantLlmSettings.tenant_id,
      set: {
        llm_provider: "mock",
        llm_primary_model: "conv-quota-primary",
        llm_fallback_model: "conv-quota-fallback",
      },
    })
    .returning();
  void settings;
});

afterAll(async () => {
  await srv.cleanup();
});

describe("POST /v1/conversations provider-limit handling", () => {
  test("returns 429 llm_provider_limited instead of a generic 500", async () => {
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
    expect(body.code).toBe("llm_provider_limited");
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
        pending_elicitation?: { id?: string; tool_name?: string; summary?: string };
      };
    };
    expect(body.code).toBe("pending_elicitation_blocked");
    expect(body.message).toContain("resolve the pending dialog");
    expect(body.details?.conversation_status).toBe("awaiting_input");
    expect(body.details?.pending_elicitation).toEqual({
      id: elicitation.id,
      tool_name: "ask_user_form",
      summary: "Provide your DigitalOcean API token",
    });
  });
});
