// B — auto-compaction reduces the assembled context so a full conversation can
// degrade instead of throwing a hard `LlmContextTooLarge`.
//
// The loop pre-flight (`loop.ts`) now, on crossing the model's usable context
// cap, compacts the conversation ONCE and rebuilds the model messages before
// deciding whether the turn still cannot fit. The load-bearing operation that
// retry depends on is exactly this: after `compactConversation`, the token count
// of `buildModelMessages` drops — because the older turns are replayed from a
// single compacted summary instead of verbatim. This test pins that operation
// directly and deterministically.
//
// The draft workflow lives in draft snapshots, not the chat turns, so collapsing
// turns never loses the in-progress build — which is why aggressive compaction
// is a safe degrade for authoring.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { conversationMessages, conversations, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { countModelMessagesTokens } from "../../llm/accounting/count.ts";
import { buildModelMessages } from "../persist.ts";
import { compactConversation } from "../service/compact.ts";

let ctx: TestDb;
let tenant_id: string;

beforeAll(async () => {
  ctx = await createTestDb("context_auto_compaction");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "t-cac", display_name: "T-CAC" })
    .returning();
  tenant_id = t!.id;
});

afterAll(async () => {
  await ctx.cleanup();
});

async function messageTokens(conversation_id: string): Promise<number> {
  const messages = await buildModelMessages(ctx.db, tenant_id, conversation_id, {
    conversationEnvelope: true,
    conversation_id,
  });
  return countModelMessagesTokens(messages);
}

async function countCompactedMarkers(conversation_id: string): Promise<number> {
  const rows = await ctx.db
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.tenant_id, tenant_id),
        eq(conversationMessages.conversation_id, conversation_id),
        eq(conversationMessages.role, "system"),
        sql`${conversationMessages.content}->>'kind' = 'compacted'`,
      ),
    );
  return rows.length;
}

describe("context auto-compaction mechanism (B)", () => {
  test("compacting a large conversation collapses history and shrinks the rebuilt model-message tokens", async () => {
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "active" })
      .returning({ id: conversations.id });
    const conversationId = conv!.id;

    // A pile of large, verbatim history — the shape a long authoring session
    // accumulates. Alternating roles so replay pairs them naturally.
    const bigBlock = "lorem ipsum dolor sit amet consectetur ".repeat(560); // ~22k chars
    for (let i = 0; i < 30; i += 1) {
      await ctx.db.insert(conversationMessages).values({
        tenant_id,
        conversation_id: conversationId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: { text: `${bigBlock} #${i}` },
      });
    }

    const before = await messageTokens(conversationId);
    expect(before).toBeGreaterThan(20_000);
    expect(await countCompactedMarkers(conversationId)).toBe(0);

    const result = await compactConversation(
      { tenant_id, conversation_id: conversationId, actor_id: null },
      ctx.db,
    );
    expect(result.messages_collapsed).toBeGreaterThan(0);

    // A single compacted-summary marker now exists (history collapsed, not
    // deleted), and the rebuilt model messages are dramatically smaller — the
    // reduction the loop pre-flight relies on to fit the retry under the cap.
    expect(await countCompactedMarkers(conversationId)).toBe(1);
    const after = await messageTokens(conversationId);
    expect(after).toBeLessThan(before / 2);
  }, 30_000);

  test("compacting an already-minimal conversation collapses nothing — the loop then throws instead of looping", async () => {
    const [conv] = await ctx.db
      .insert(conversations)
      .values({ tenant_id, status: "active" })
      .returning({ id: conversations.id });
    const conversationId = conv!.id;
    // Fewer messages than `keep_last` (default 4): nothing to collapse.
    for (let i = 0; i < 2; i += 1) {
      await ctx.db.insert(conversationMessages).values({
        tenant_id,
        conversation_id: conversationId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: { text: `short ${i}` },
      });
    }

    const result = await compactConversation(
      { tenant_id, conversation_id: conversationId, actor_id: null },
      ctx.db,
    );
    // messages_collapsed === 0 is the loop's signal to stop and throw
    // `LlmContextTooLarge` rather than compact fruitlessly in a loop.
    expect(result.messages_collapsed).toBe(0);
    expect(await countCompactedMarkers(conversationId)).toBe(0);
  }, 30_000);
});
