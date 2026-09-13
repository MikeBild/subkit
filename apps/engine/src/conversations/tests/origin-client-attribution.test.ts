// Per-client attribution of elicitation outcomes.
//
// The claim this pins: an elicitation can be attributed to the client that
// opened its conversation, by joining `conversation_elicitations.conversation_id`
// to `conversations.origin_client`. That join is the whole reason the column
// exists — it is what turns an aggregate like "0 of 29 elicitations were ever
// fulfilled" into a per-client matrix, which is the evidence a per-channel
// decision has to rest on.
//
// Without a test, the column is only a claim: it would keep persisting nulls,
// or the join would silently return one bucket, and the resulting matrix would
// read as "every client behaves identically" — the exact wrong conclusion.

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

/** Open a conversation attributed to `origin`, then pause it on an elicitation. */
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

    // The property that makes the matrix meaningful: two clients that a single
    // person authorised do NOT collapse into one row.
    expect(byConversation.get(browserA)).not.toBe(byConversation.get(browserB));
  });

  test("a conversation opened without a channel credential records null, not a placeholder", async () => {
    // A REPL or internal caller has no registered client. Inventing a value
    // would put a channel into the matrix that never connected.
    const id = await seedPausedConversation(null);
    const [row] = await ctx.testDb.db
      .select({ origin_client: conversations.origin_client })
      .from(conversations)
      .where(eq(conversations.id, id))
      .limit(1);

    expect(row?.origin_client).toBeNull();
  });
});
