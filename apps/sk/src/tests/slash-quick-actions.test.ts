import { describe, expect, mock, test } from "bun:test";
import type { SkSessionState } from "@cli-core/index.ts";
import type { ResolvedProfile } from "../config.ts";
import type { EngineClient } from "../engine-client.ts";
import { handleSlash, type SlashHandlerContext } from "../repl/slash/handler.ts";

function makeCtx(
  opts: {
    client?: EngineClient;
    conversationId?: string | null;
    messages?: Array<{ role: string; content: string; id?: string }>;
    setConversationId?: (id: string | null) => void;
  } = {},
): SlashHandlerContext {
  const client =
    opts.client ??
    ({
      patchConversation: mock(async () => ({})),
    } as unknown as EngineClient);
  const session = {
    conversationId: "conversationId" in opts ? opts.conversationId : "conv-1",
    status: "idle",
    messages: opts.messages ?? [],
    toolCalls: [],
    usage: null,
  } as unknown as SkSessionState;
  return {
    client,
    profile: {
      name: "default",
      engine_url: "http://localhost:3000",
    } as ResolvedProfile,
    session,
    setConversationId: opts.setConversationId ?? (() => {}),
    allowedPermissions: [
      "conversation:read",
      "conversation:write",
      "conversation:list",
      "skill:read",
      "knowledge:read",
    ],
  };
}

describe("/copy slash (M9)", () => {
  test("returns hint when there is no assistant message", async () => {
    const out = await handleSlash("copy", [], makeCtx({ messages: [] }));
    expect(out).toBe("/copy: no assistant message yet");
  });

  test("copies the most recent assistant message text (or reports clipboard non-TTY)", async () => {
    const out = await handleSlash(
      "copy",
      [],
      makeCtx({
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "hello world" },
          { role: "user", content: "more" },
          { role: "assistant", content: "second reply" },
        ],
      }),
    );
    expect(typeof out).toBe("string");
    expect(out).toMatch(
      /(copied last assistant message \(12 chars\)|clipboard not writable on this terminal)/,
    );
  });

  test("returns empty-message hint when last assistant turn has empty content", async () => {
    const out = await handleSlash(
      "copy",
      [],
      makeCtx({
        messages: [{ role: "assistant", content: "" }],
      }),
    );
    expect(out).toBe("/copy: last assistant message is empty");
  });

  test("falls back to engine getConversation when in-memory transcript has no assistant turn (string content)", async () => {
    const getConversation = mock(async () => ({
      conversation: { id: "c-1" },
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "persisted reply text" },
      ],
      tool_calls: [],
      draft: null,
    }));
    const client = { getConversation } as unknown as EngineClient;
    const out = await handleSlash(
      "copy",
      [],
      makeCtx({ client, conversationId: "c-1", messages: [] }),
    );
    expect(getConversation.mock.calls.length).toBe(1);
    const args = getConversation.mock.calls[0] as unknown as [string];
    expect(args[0]).toBe("c-1");
    expect(typeof out).toBe("string");
    expect(out).toMatch(
      /(copied last assistant message \(20 chars\)|clipboard not writable on this terminal)/,
    );
  });

  test("structured (non-string) content collapses to empty and the no-assistant-turn hint fires", async () => {
    const getConversation = mock(async () => ({
      conversation: { id: "c-2" },
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "structured" }],
        },
      ],
      tool_calls: [],
      draft: null,
    }));
    const client = { getConversation } as unknown as EngineClient;
    const out = await handleSlash(
      "copy",
      [],
      makeCtx({ client, conversationId: "c-2", messages: [] }),
    );
    expect(getConversation.mock.calls.length).toBe(1);
    expect(out).toBe("/copy: no assistant message yet");
  });

  test("engine getConversation failure does not throw and falls through to the hint", async () => {
    const getConversation = mock(async () => {
      throw new Error("engine offline");
    });
    const client = { getConversation } as unknown as EngineClient;
    const out = await handleSlash(
      "copy",
      [],
      makeCtx({ client, conversationId: "c-3", messages: [] }),
    );
    expect(getConversation.mock.calls.length).toBe(1);
    expect(out).toBe("/copy: no assistant message yet");
  });
});

describe("/rename slash (M9)", () => {
  test("rejects when no active conversation", async () => {
    const out = await handleSlash("rename", ["My", "session"], makeCtx({ conversationId: null }));
    expect(out).toBe("/rename: no active conversation");
  });

  test("calls patchConversation with the title and reports success", async () => {
    const patchConversation = mock(async () => ({}));
    const client = { patchConversation } as unknown as EngineClient;
    const out = await handleSlash(
      "rename",
      ["My", "great", "session"],
      makeCtx({ client, conversationId: "conv-1" }),
    );
    expect(patchConversation.mock.calls.length).toBe(1);
    const args0 = patchConversation.mock.calls[0] as unknown as [string, { title: string }];
    expect(args0[0]).toBe("conv-1");
    expect(args0[1]).toEqual({ title: "My great session" });
    expect(out).toContain("My great session");
  });
});

describe("/fork slash", () => {
  test("calls forkConversationFromMessage with the most recent assistant id and switches sessionId", async () => {
    const forkConversationFromMessage = mock(async (sourceId: string, msgId: string) => ({
      conversation: { id: "11111111-1111-1111-1111-111111111111" } as unknown,
      source_conversation_id: sourceId,
      anchor_message_id: msgId,
      copied_message_count: 4,
      truncated: false,
    }));
    const client = { forkConversationFromMessage } as unknown as EngineClient;

    let setTo: string | null | undefined;
    const out = await handleSlash(
      "fork",
      [],
      makeCtx({
        client,
        conversationId: "source-conv-1",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "first reply", id: "msg-1" },
          { role: "user", content: "more" },
          { role: "assistant", content: "second reply", id: "msg-2" },
        ],
        setConversationId: (id) => {
          setTo = id;
        },
      }),
    );
    expect(forkConversationFromMessage.mock.calls.length).toBe(1);
    const args = forkConversationFromMessage.mock.calls[0] as unknown as [string, string];
    expect(args[0]).toBe("source-conv-1");
    expect(args[1]).toBe("msg-2");
    expect(setTo).toBe("11111111-1111-1111-1111-111111111111");
    expect(out).toMatch(/forked from source-c at message msg-2/);
    expect(out).toMatch(/4 messages copied/);
  });

  test("returns guidance when no persisted assistant turn exists", async () => {
    const forkConversationFromMessage = mock(async () => {
      throw new Error("should not be called");
    });
    const client = { forkConversationFromMessage } as unknown as EngineClient;
    const out = await handleSlash(
      "fork",
      [],
      makeCtx({
        client,
        conversationId: "source-1",
        messages: [
          { role: "user", content: "hi" },
          { role: "assistant", content: "in progress" },
        ],
      }),
    );
    expect(out).toMatch(/no persisted assistant turn/);
    expect(forkConversationFromMessage.mock.calls.length).toBe(0);
  });

  test("surfaces engine error verbatim", async () => {
    const forkConversationFromMessage = mock(async () => {
      throw new Error("forbidden — conversation:write required");
    });
    const client = { forkConversationFromMessage } as unknown as EngineClient;
    const out = await handleSlash(
      "fork",
      [],
      makeCtx({
        client,
        conversationId: "source-1",
        messages: [{ role: "assistant", content: "ok", id: "msg-x" }],
      }),
    );
    expect(out).toContain("/fork failed");
    expect(out).toContain("forbidden");
  });

  test("explains when no session to fork from", async () => {
    const out = await handleSlash("fork", [], makeCtx({ conversationId: null }));
    expect(out).toBe("no session to fork from");
  });
});

describe("/mention slash (M9)", () => {
  test("returns the inline-picker hint", async () => {
    const out = await handleSlash("mention", [], makeCtx({}));
    expect(out).toContain("type `@` in the composer");
  });
});
