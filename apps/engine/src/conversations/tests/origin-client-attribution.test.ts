import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { conversationElicitations, conversations } from "../../db/schema/index.ts";
import { createElicitation } from "../elicitations.ts";
import * as svc from "../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("origin_client_attribution");
}, 60_000);

afterAll(async () => {
  await ctx?.cleanup();
}, 30_000);

async function seedPausedConversation(origin: string | null): Promise<string> {
  const created = await svc.createConversation(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      ...(origin !== null ? { origin_client: origin } : {}),
    },
    ctx.testDb.db,
  );
  await createElicitation(
    {
      tenant_id: ctx.tenant_id,
      conversation_id: created.conversation.id,
      tool_call_id: null,
      tool_name: "ask_user_text",
      summary: "which environment?",
      input: { kind: "text" },
      actor_id: ctx.user_id,
    },
    ctx.testDb.db,
  );
  return created.conversation.id;
}

describe("elicitation outcomes are attributable to the originating client", () => {
  test("the join yields one bucket per client, not one bucket overall", async () => {
    const db = ctx.testDb.db;
    const browserA = await seedPausedConversation("mcp_oauth:client-browser-a");
    const browserB = await seedPausedConversation("mcp_oauth:client-browser-b");
    const codingAgent = await seedPausedConversation("api_key:key-coding-agent");

    const rows = await db
      .select({
        conversation_id: conversationElicitations.conversation_id,
        status: conversationElicitations.status,
        origin_client: conversations.origin_client,
      })
      .from(conversationElicitations)
      .innerJoin(conversations, eq(conversations.id, conversationElicitations.conversation_id))
      .where(eq(conversationElicitations.tenant_id, ctx.tenant_id));

    const byConversation = new Map(rows.map((r) => [r.conversation_id, r.origin_client]));
    expect(byConversation.get(browserA)).toBe("mcp_oauth:client-browser-a");
    expect(byConversation.get(browserB)).toBe("mcp_oauth:client-browser-b");
    expect(byConversation.get(codingAgent)).toBe("api_key:key-coding-agent");

    expect(byConversation.get(browserA)).not.toBe(byConversation.get(browserB));
  });

  test("a conversation opened without a channel credential records null, not a placeholder", async () => {
    const id = await seedPausedConversation(null);
    const [row] = await ctx.testDb.db
      .select({ origin_client: conversations.origin_client })
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);

    expect(row?.origin_client).toBeNull();
  });
});
