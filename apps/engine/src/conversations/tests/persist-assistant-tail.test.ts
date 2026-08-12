// `buildModelMessages` must never hand the provider an array that ends on an
// assistant turn.
//
// Regression: a turn resumed by a resolved elicitation carries no
// `currentUserMessage`, so the array is pure replay. `empty_turn_fallback`
// appends a SYNTHETIC assistant message after the tool rows, which therefore
// lands last in `created_at` order. Anthropic reads a trailing assistant turn as
// an attempt to prefill the reply and fails the whole turn with "This model does
// not support assistant message prefill. The conversation must end with a user
// message." — observed in production against claude-haiku-4-5, taking the
// `conversation.run-turn` job down with it.

import { beforeAll, describe, expect, it } from "bun:test";
import { conversationMessages, conversations } from "../../db/schema/index.ts";
import { createLlmTestCtx, type LlmTestCtx } from "../../llm/tests/setup.ts";
import { buildModelMessages } from "../persist.ts";

let ctx: LlmTestCtx;

beforeAll(async () => {
  ctx = await createLlmTestCtx("persist-assistant-tail");
});

async function seedConversation(
  rows: Array<{ role: "user" | "assistant"; text: string; content?: Record<string, unknown> }>,
): Promise<string> {
  const [conv] = await ctx.testDb.db
    .insert(conversations)
    .values({ tenant_id: ctx.tenant_id, status: "active" })
    .returning({ id: conversations.id });
  const conversation_id = conv!.id;
  // Distinct, increasing `created_at` so replay order is unambiguous.
  let t = Date.parse("2026-08-12T07:00:00Z");
  for (const row of rows) {
    t += 1_000;
    await ctx.testDb.db.insert(conversationMessages).values({
      tenant_id: ctx.tenant_id,
      conversation_id,
      role: row.role,
      content: row.content ?? { text: row.text },
      created_at: new Date(t),
    });
  }
  return conversation_id;
}

describe("buildModelMessages — assistant tail", () => {
  it("drops a trailing assistant message when the turn is resumed with no new user message", async () => {
    const conversation_id = await seedConversation([
      { role: "user", text: "author the review workflow" },
      { role: "assistant", text: "I need your approval to replace version 1." },
    ]);

    const messages = await buildModelMessages(ctx.testDb.db, ctx.tenant_id, conversation_id, {});

    expect(messages.length).toBeGreaterThan(0);
    expect(messages[messages.length - 1]?.role).not.toBe("assistant");
    expect(messages[messages.length - 1]?.role).toBe("user");
  });

  it("drops a synthetic empty_turn_fallback tail too", async () => {
    const conversation_id = await seedConversation([
      { role: "user", text: "run the review" },
      { role: "assistant", text: "working on it" },
      { role: "user", text: "any update?" },
      {
        role: "assistant",
        text: "fallback",
        content: { text: "fallback", _synthetic: true, _reason: "empty_turn_fallback" },
      },
    ]);

    const messages = await buildModelMessages(ctx.testDb.db, ctx.tenant_id, conversation_id, {});

    expect(messages[messages.length - 1]?.role).toBe("user");
    // Only the tail goes — earlier assistant context is preserved.
    expect(messages.some((m) => m.role === "assistant")).toBe(true);
  });

  it("leaves the array alone when a current user message closes the turn", async () => {
    const conversation_id = await seedConversation([
      { role: "user", text: "first" },
      { role: "assistant", text: "answered" },
    ]);

    const messages = await buildModelMessages(ctx.testDb.db, ctx.tenant_id, conversation_id, {
      currentUserMessage: "and now this",
    });

    const last = messages[messages.length - 1];
    expect(last?.role).toBe("user");
    expect(last?.content).toBe("and now this");
    // The assistant turn in the middle is untouched.
    expect(messages.some((m) => m.role === "assistant")).toBe(true);
  });

  it("keeps a lone assistant message rather than sending an empty array", async () => {
    const conversation_id = await seedConversation([
      { role: "assistant", text: "greeting with no user turn beneath it" },
    ]);

    const messages = await buildModelMessages(ctx.testDb.db, ctx.tenant_id, conversation_id, {});

    // Nothing to fall back to — an empty `messages` array is rejected by
    // providers just as hard as an assistant tail.
    expect(messages.length).toBe(1);
    expect(messages[0]?.role).toBe("assistant");
  });
});
