import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SuggestNextKind, SuggestNextReason } from "@shared/suggest-next-reasons.ts";
import { eq } from "drizzle-orm";
import { tenants } from "../../db/schema/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { adminHeaders } from "../../test-helpers/seed.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();
  srv = await createHttpTestServer("conv-client-suppress");
  await srv.db
    .update(tenants)
    .set({ llm_primary: "client-suppress-primary", llm_fallback: "client-suppress-fallback" })
    .where(eq(tenants.id, srv.tenantId));
});

afterAll(async () => {
  await srv.cleanup();
});

interface NextSuggestionEvent {
  type: "next_suggestion";
  suggestion: string | null;
  reason: SuggestNextReason;
  kind: SuggestNextKind | null;
}

describe("POST /v1/conversations/:id/messages — client_suppress wire round-trip", () => {
  test("client_suppress: true → next_suggestion frame with reason: client-suppress", async () => {
    resetMockProvider();
    const createRes = await fetch(`${srv.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: adminHeaders(srv.apiKey),
      body: JSON.stringify({ initial_message: "hello" }),
    });
    expect([200, 201]).toContain(createRes.status);
    const created = (await createRes.json()) as { conversation: { id: string } };
    const conversationId = created.conversation.id;
    getMockProvider().setConversePlan(conversationId, []);

    const res = await fetch(`${srv.baseUrl}/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: adminHeaders(srv.apiKey),
      body: JSON.stringify({
        message: "say hi",
        client_suppress: true,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ type: string }> };
    const suggestionFrames = body.events.filter(
      (e): e is NextSuggestionEvent => e.type === "next_suggestion",
    );
    expect(suggestionFrames).toHaveLength(1);
    expect(suggestionFrames[0]).toMatchObject({
      type: "next_suggestion",
      suggestion: null,
      reason: "client-suppress",
      kind: null,
    });
  });

  test("client_suppress omitted → suggestion runs (reason ≠ client-suppress)", async () => {
    resetMockProvider();
    const createRes = await fetch(`${srv.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: adminHeaders(srv.apiKey),
      body: JSON.stringify({ initial_message: "kick off" }),
    });
    const created = (await createRes.json()) as { conversation: { id: string } };
    const conversationId = created.conversation.id;
    getMockProvider().setConversePlan(conversationId, []);

    const res = await fetch(`${srv.baseUrl}/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: adminHeaders(srv.apiKey),
      body: JSON.stringify({
        message: "do the thing",
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { events: Array<{ type: string }> };
    const suggestionFrames = body.events.filter(
      (e): e is NextSuggestionEvent => e.type === "next_suggestion",
    );
    expect(suggestionFrames).toHaveLength(1);
    expect(suggestionFrames[0]?.reason).not.toBe("client-suppress");
  });

  test("client_suppress: 'yes' (non-boolean) → 400 (Zod rejects)", async () => {
    resetMockProvider();
    const createRes = await fetch(`${srv.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: adminHeaders(srv.apiKey),
      body: JSON.stringify({ initial_message: "boot" }),
    });
    const created = (await createRes.json()) as { conversation: { id: string } };
    const conversationId = created.conversation.id;

    const res = await fetch(`${srv.baseUrl}/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: adminHeaders(srv.apiKey),
      body: JSON.stringify({
        message: "x",
        client_suppress: "yes",
      }),
    });
    expect(res.status).toBe(400);
  });
});
