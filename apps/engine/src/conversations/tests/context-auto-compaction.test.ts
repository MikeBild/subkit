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

    const bigBlock = "lorem ipsum dolor sit amet consectetur ".repeat(560);
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
    expect(result.messages_collapsed).toBe(0);
    expect(await countCompactedMarkers(conversationId)).toBe(0);
  }, 30_000);
});
