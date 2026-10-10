import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  respondToChatApproval,
  respondToChatChoice,
  respondToChatForm,
  sendConversationTurn,
} from "./client";

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

  test("hands the created conversation to the caller before a failing turn ends", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(
          'event: conversation_started\ndata: {"conversation":{"id":"conversation-9"}}\n\nevent: error\ndata: {"code":"internal","message":"boom"}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    ) as unknown as typeof fetch;
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    await expect(
      sendConversationTurn({ message: "hi" }, (event) => events.push(event)),
    ).rejects.toThrow("boom");
    expect(events).toEqual([
      { type: "conversation_started", conversation: { id: "conversation-9" } },
    ]);
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

  test("sends the selected intake ids only when the conversation starts", async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      outcomeResponse(),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await sendConversationTurn({
      message: "review these",
      intake_item_ids: ["018f4b4a-6d33-7b3a-9c2d-123456789abc"],
    });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toEqual({
      initial_message: "review these",
      intake_item_ids: ["018f4b4a-6d33-7b3a-9c2d-123456789abc"],
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

describe("answering pending conversation questions", () => {
  const question = { id: "question-1", tool_name: "ask_user_text" };
  const blocked = (tool = "ask_user_text") =>
    new Response(
      `event: error\ndata: ${JSON.stringify({ code: "pending_elicitation_blocked", message: "resolve the pending dialog", details: { pending_elicitation: { ...question, tool_name: tool } } })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );

  test("answers the displayed text question through its canonical endpoint", async () => {
    const calls: { path: string; body: unknown }[] = [];
    globalThis.fetch = mock(async (path: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ path: String(path), body: JSON.parse(String(init?.body)) });
      return outcomeResponse();
    }) as unknown as typeof fetch;
    await sendConversationTurn({
      conversationId: "conversation-1",
      message: "ja, aber nur vorbereiten",
      pendingElicitation: question,
    });
    expect(calls).toEqual([
      {
        path: "/v1/conversations/conversation-1/elicitations/question-1/respond",
        body: { output: { value: "ja, aber nur vorbereiten" } },
      },
    ]);
  });

  test("a text question the reader never saw does not take their message as its answer", async () => {
    const fetchMock = mock(async () => blocked());
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      sendConversationTurn({
        conversationId: "conversation-1",
        message: "ich sehe hier keinen dialog",
      }),
    ).rejects.toMatchObject({
      code: "pending_elicitation_blocked",
      details: { pending_elicitation: { tool_name: "ask_user_text" } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("never turns typed yes into confirmation of a structured approval", async () => {
    const fetchMock = mock(async () => blocked("ask_user_confirm"));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      sendConversationTurn({
        conversationId: "conversation-1",
        message: "ja",
        pendingElicitation: { ...question, tool_name: "ask_user_confirm" },
      }),
    ).rejects.toMatchObject({
      code: "pending_elicitation_blocked",
      details: { pending_elicitation: { tool_name: "ask_user_confirm" } },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("does not retry a stale or rejected elicitation answer", async () => {
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({ code: "elicitation_already_resolved", message: "already answered" }),
          { status: 409 },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      sendConversationTurn({
        conversationId: "conversation-1",
        message: "Blau",
        pendingElicitation: question,
      }),
    ).rejects.toMatchObject({ status: 409, code: "elicitation_already_resolved" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("never replays an ordinary failure as an answer", async () => {
    const fetchMock = mock(
      async () => new Response('event: error\ndata: {"code":"internal","message":"failed"}\n\n'),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    await expect(
      sendConversationTurn({ conversationId: "conversation-1", message: "Blau" }),
    ).rejects.toMatchObject({ code: "internal" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

for (const confirmed of [true, false]) {
  test(`chat approval sends the explicit ${confirmed} decision to the canonical elicitation`, async () => {
    const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      outcomeResponse(),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockImplementation(
      async () =>
        new Response(
          'event: message\ndata: {"type":"text_delta","text":"Weiter"}\n\nevent: outcome\ndata: {"conversation":{"id":"conversation-1"}}\n\n',
        ),
    );
    const event = mock(() => {});
    await respondToChatApproval("conversation/1", "elicitation/2", confirmed, event);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(path).toBe("/v1/conversations/conversation%2F1/elicitations/elicitation%2F2/respond");
    expect(JSON.parse(String(init.body))).toEqual({ output: { confirmed } });
    expect(event).toHaveBeenCalled();
  });
}
test("a stale approval is surfaced without retrying the decision", async () => {
  const fetchMock = mock(
    async () =>
      new Response(
        JSON.stringify({
          error: { code: "elicitation_already_resolved", message: "Already decided" },
        }),
        { status: 409 },
      ),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  await expect(respondToChatApproval("c", "e", true)).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(1);
});

test("choice submits exactly the declared value to the canonical request route", async () => {
  const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    outcomeResponse(),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  await respondToChatChoice("conversation-1", "request-1", "dryrun");
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [path, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(path).toBe("/v1/conversations/conversation-1/elicitations/request-1/respond");
  expect(JSON.parse(String(init.body))).toEqual({ output: { value: "dryrun" } });
});

test("form submission and cancellation use the exact pending elicitation endpoint", async () => {
  const fetchMock = mock(async (_input: RequestInfo | URL, _init?: RequestInit) =>
    outcomeResponse(),
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  await respondToChatForm("conversation/1", "form/1", { values: { days: 7, include: false } });
  await respondToChatForm("conversation/1", "form/1", { declined: true });
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "/v1/conversations/conversation%2F1/elicitations/form%2F1/respond",
  );
  expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
    output: { values: { days: 7, include: false } },
  });
  expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
    output: { declined: true },
  });
});
