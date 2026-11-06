import { beforeAll, describe, expect, it } from "bun:test";
import { conversations } from "../../db/schema/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import { appendMessage, buildModelMessages } from "../persistence/index.ts";

let ctx: LlmTestCtx;

beforeAll(async () => {
  ctx = await createLlmTestCtx("persist-textless-assistant");
});

async function newConversation(): Promise<string> {
  const [conv] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  return conv!.id;
}

function serialized(messages: unknown[]): string {
  return JSON.stringify(messages);
}

describe("buildModelMessages — assistant turns without text", () => {
  for (const [label, content] of [
    ["an empty object", {}],
    ["an empty text", { text: "" }],
    ["only guard violations", { _violations: [{ kind: "url", message: "rewritten" }] }],
    [
      "an empty text with guard violations",
      { text: "", _violations: [{ kind: "url", message: "x" }] },
    ],
  ] as const) {
    it(`never replays a stored assistant turn with ${label} as JSON`, async () => {
      const conversation_id = await newConversation();
      const db = ctx.testDb.db;
      await appendMessage(db, ctx.tenant_id, conversation_id, "user", {
        text: "list my workflows",
      });
      await appendMessage(db, ctx.tenant_id, conversation_id, "assistant", content);
      await appendMessage(db, ctx.tenant_id, conversation_id, "assistant", {
        text: "Here are your workflows.",
      });
      await appendMessage(db, ctx.tenant_id, conversation_id, "user", { text: "thanks" });

      const messages = await buildModelMessages(db, ctx.tenant_id, conversation_id, {});

      const assistant = messages.filter((m) => m.role === "assistant");
      expect(assistant.map((m) => m.content)).toEqual(["Here are your workflows."]);
      expect(serialized(messages)).not.toContain('"{}"');
      expect(serialized(messages)).not.toContain("_violations");
    });
  }
});
