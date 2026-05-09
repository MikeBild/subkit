// Quick-action slashes (M9 of #159) — /copy /rename /fork /mention.
// /init, /draft, /export already existed pre-M9 and are exercised
// elsewhere; /mention here is just a hint string so the test asserts
// shape only.

import { describe, expect, mock, test } from "bun:test";
import type { SkSessionState } from "@cli-core/index.ts";
import type { ResolvedProfile } from "../config.ts";
import type { EngineClient } from "../engine-client.ts";
import { handleSlash, type SlashHandlerContext } from "../repl/slash/handler.ts";

function makeCtx(
  opts: {
    client?: EngineClient;
    conversationId?: string | null;
    messages?: Array<{ role: string; content: string }>;
    setConversationId?: (id: string | null) => void;
  } = {},
): SlashHandlerContext {
  const client =
    opts.client ??
    ({
      patchConversation: mock(async () => ({})),
    } as unknown as EngineClient);
  const session = {
    // Use `in` instead of `??` so an explicit `conversationId: null`
    // overrides the default rather than being treated as nullish.
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
    // Two acceptable outputs depending on whether stdout is a TTY:
    //   - TTY: "copied last assistant message (12 chars) to clipboard"
    //   - non-TTY (most CI envs): "/copy failed: clipboard not writable on this terminal"
    // The contract is that /copy never throws and never returns null.
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

describe("/fork slash (M9)", () => {
  test("calls setConversationId(null) and returns the previous id in the message", async () => {
    let setTo: string | null | undefined;
    const out = await handleSlash(
      "fork",
      [],
      makeCtx({
        conversationId: "conv-prev",
        setConversationId: (id) => {
          setTo = id;
        },
      }),
    );
    expect(setTo).toBeNull();
    expect(out).toContain("forked from conv-prev");
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
