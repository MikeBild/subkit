import { afterEach, describe, expect, mock, test } from "bun:test";

import { sendConversationTurn } from "./client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function outcomeResponse(): Response {
  return new Response(
    'event: outcome\ndata: {"conversation":{"id":"conversation-1"},"result":{"status":"active"}}\n\n',
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("sendConversationTurn", () => {
  test("creates a conversation with the shared message, target, and reference contract", async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      outcomeResponse(),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sendConversationTurn({
      message: "inspect it",
      target: { workflow_id: "workflow-1" },
      references: [{ type: "workflow", id: "workflow-1", label: "customer-sync" }],
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/v1/conversations");
    expect(JSON.parse(String(init.body))).toEqual({
      initial_message: "inspect it",
      workflow_id: "workflow-1",
      references: [{ type: "workflow", id: "workflow-1", label: "customer-sync" }],
    });
  });

  test("preserves an explicit conservative mode for a new conversation", async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      outcomeResponse(),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await sendConversationTurn({ message: "inspect it", permissionMode: "ask" });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      initial_message: "inspect it",
      permission_mode: "ask",
    });
  });

  test("appends through the same API without leaking create-only fields", async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      outcomeResponse(),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await sendConversationTurn({
      conversationId: "conversation/1",
      message: "continue",
      references: [{ type: "connector", id: "connector-1", label: "crm" }],
    });

    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/v1/conversations/conversation%2F1/messages");
    expect(JSON.parse(String(init.body))).toEqual({
      message: "continue",
      references: [{ type: "connector", id: "connector-1", label: "crm" }],
    });
  });
});
