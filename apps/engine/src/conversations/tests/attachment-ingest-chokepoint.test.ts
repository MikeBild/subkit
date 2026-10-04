import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import { conversationMessages, conversations } from "../../db/schema/index.ts";
import { FILE_SENTINEL_RE } from "../../files/sentinel.ts";
import { attachInlineForTest } from "../../files/test-helpers.ts";
import { appendUserMessage, createConversation } from "../service.ts";
import { type ConversationTestCtx, createConversationTestCtx } from "./setup.ts";

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("attachment_ingest_chokepoint");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("attachment ingest chokepoint", () => {
  test("@attachment:<slug> in user message → persisted as [file:fid_...] sentinel", async () => {
    const created = await createConversation(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        initial_message: "hello",
      },
      ctx.testDb.db,
    );
    const conversation_id = created.conversation.id;

    const attached = await attachInlineForTest({
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id,
      filename: "policy.txt",
      content: "secret contents",
      slug: "policy-doc",
    });

    await appendUserMessage(
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        actor_id: ctx.user_id,
        message: "check @attachment:policy-doc please",
      },
      ctx.testDb.db,
    );

    const rows = await ctx.testDb.db
      .select()
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.tenant_id, ctx.tenant_id),
          eq(conversationMessages.conversation_id, conversation_id),
          eq(conversationMessages.role, "user"),
        ),
      )
      .orderBy(asc(conversationMessages.created_at));

    const lastUser = rows[rows.length - 1];
    expect(lastUser).toBeDefined();
    const content = lastUser!.content as { text?: unknown };
    const text = typeof content?.text === "string" ? content.text : "";

    const re = new RegExp(FILE_SENTINEL_RE.source, "g");
    expect(re.test(text)).toBe(true);
    expect(text).toContain(`[file:${attached.file_id}]`);
    expect(text).not.toContain("@attachment:policy-doc");

    const [conv] = await ctx.testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation_id));
    expect(conv).toBeDefined();
  });
});
