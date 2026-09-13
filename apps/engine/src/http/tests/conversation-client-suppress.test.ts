// HTTP-layer pin for the `client_suppress` body field on
// POST /v1/conversations/:id/messages.
//
// The plumbing chain is:
//   HTTP body `client_suppress: true`
//   → AppendMessageBody (Zod) parses it
//   → messages.ts spreads `next_suggestion_suppress: body.client_suppress`
//   → service/append.ts forwards to runLoop
//   → runLoop forwards p.next_suggestion_suppress to buildNextSuggestionFrame
//   → service emits `{ suggestion: null, reason: "client-suppress" }`.
//
// The seam most likely to silently drop the field is the spread in
// messages.ts. This test pins the round-trip end-to-end so a future
// refactor of that spread cannot quietly disconnect the wiring without
// failing CI.

import type { SuggestNextKind, SuggestNextReason } from "@shared/suggest-next-reasons.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { tenantLlmSettings } from "../../db/schema/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;

beforeAll(async () => {
  process.env.LLM_PROVIDER = "mock";
  resetMockProvider();
  srv = await createHttpTestServer("conv-client-suppress");
  await srv.db
    .insert(tenantLlmSettings)
    .values({
      tenant_id: srv.tenantId,
      llm_provider: "mock",
      llm_primary_model: "client-suppress-primary",
      llm_fallback_model: "client-suppress-fallback",
    })
    .onConflictDoUpdate({
      target: tenantLlmSettings.tenant_id,
      set: {
        llm_provider: "mock",
        llm_primary_model: "client-suppress-primary",
        llm_fallback_model: "client-suppress-fallback",
      },
    });
});

afterAll(async () => {
  await srv.cleanup();
});

// Tightened to import the shared SuggestNextReason / SuggestNextKind
// unions so a typo in the engine fails this test instead of being
// accepted as a generic string.
interface NextSuggestionEvent {
  type: "next_suggestion";
  suggestion: string | null;
  reason: SuggestNextReason;
  kind: SuggestNextKind | null;
}

function adminHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${srv.apiKey}`,
    "Content-Type": "application/json",
  };
}

describe("POST /v1/conversations/:id/messages — client_suppress wire round-trip", () => {
  test("client_suppress: true → next_suggestion frame with reason: client-suppress", async () => {
    resetMockProvider();
    // Empty plan = mock returns `{done: true}` on first ask, the loop
    // ends without tool calls, suggestion path runs.
    const createRes = await fetch(`${srv.baseUrl}/v1/conversations`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({ initial_message: "hello" }),
    });
    expect([200, 201]).toContain(createRes.status);
    const created = (await createRes.json()) as { conversation: { id: string } };
    const conversationId = created.conversation.id;
    getMockProvider().setConversePlan(conversationId, []);

    const res = await fetch(`${srv.baseUrl}/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: adminHeaders(),
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
      headers: adminHeaders(),
      body: JSON.stringify({ initial_message: "kick off" }),
    });
    const created = (await createRes.json()) as { conversation: { id: string } };
    const conversationId = created.conversation.id;
    getMockProvider().setConversePlan(conversationId, []);

    const res = await fetch(`${srv.baseUrl}/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: adminHeaders(),
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
      headers: adminHeaders(),
      body: JSON.stringify({ initial_message: "boot" }),
    });
    const created = (await createRes.json()) as { conversation: { id: string } };
    const conversationId = created.conversation.id;

    const res = await fetch(`${srv.baseUrl}/v1/conversations/${conversationId}/messages`, {
      method: "POST",
      headers: adminHeaders(),
      body: JSON.stringify({
        message: "x",
        client_suppress: "yes",
      }),
    });
    expect(res.status).toBe(400);
  });
});
