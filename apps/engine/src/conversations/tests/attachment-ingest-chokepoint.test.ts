// Pin the `@attachment:<slug>` → `[file:fid_<uuid>]` rewrite chokepoint.
//
// The runLoop ingest path rewrites every `@attachment:<slug>` token into
// the canonical `[file:fid_<uuid>]` sentinel BEFORE persisting the user
// message (see `apps/engine/src/conversations/loop.ts` —
// `resolveAttachmentSlugsInText` + `appendMessage`). This is the single
// surface that translates legacy slug tokens into the post-rewriter
// form. A future refactor that moves the rewrite somewhere else — or
// drops it entirely — would re-introduce the multi-turn replay leak
// fixed in checkpoint C: prior-turn user messages would carry literal
// `[file:fid_...]` text into the LLM with no file_api / file_part /
// text_extract assembly, no provider-id reuse.
//
// This test pins the contract: after `appendUserMessage`, the persisted
// `conversation_messages.content` row matches `FILE_SENTINEL_RE` and
// the original `@attachment:<slug>` substring is gone.

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
    // Seed a fresh conversation tied to no connector (the rewrite path
    // does not depend on connector context — it only needs the
    // conversation id to scope the slug lookup).
    const created = await createConversation(
      {
        tenant_id: ctx.tenant_id,
        actor_id: ctx.user_id,
        initial_message: "hello",
      },
      ctx.testDb.db,
    );
    const conversation_id = created.conversation.id;

    // Attach a file via the production write path (writes object-store
    // bytes, inserts `files` + `file_links` rows).
    const attached = await attachInlineForTest({
      db: ctx.testDb.db,
      tenant_id: ctx.tenant_id,
      conversation_id,
      filename: "policy.txt",
      content: "secret contents",
      slug: "policy-doc",
    });

    // Drive a turn whose user content references the attachment by
    // legacy slug. The mock LLM will respond with a short ack — we
    // only care about the persisted user-row.
    await appendUserMessage(
      {
        tenant_id: ctx.tenant_id,
        conversation_id,
        actor_id: ctx.user_id,
        message: "check @attachment:policy-doc please",
        turn_abort_ctrl: new AbortController(),
      },
      ctx.testDb.db,
    );

    // Read back every user-role message in created_at order. The
    // rewrite must have applied to the second user turn (the first was
    // "hello" from `createConversation`).
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

    // The newest user row carries the rewritten content.
    const lastUser = rows[rows.length - 1];
    expect(lastUser).toBeDefined();
    const content = lastUser!.content as { text?: unknown };
    const text = typeof content?.text === "string" ? content.text : "";

    // Contract 1: persisted text matches the canonical sentinel form.
    const re = new RegExp(FILE_SENTINEL_RE.source, "g");
    expect(re.test(text)).toBe(true);
    // Contract 2: the canonical sentinel embeds the file's wire id.
    expect(text).toContain(`[file:${attached.file_id}]`);
    // Contract 3: the original `@attachment:<slug>` substring is gone.
    expect(text).not.toContain("@attachment:policy-doc");

    // Sanity: the conversation row exists (the persist+update path
    // didn't roll back on the rewrite chokepoint).
    const [conv] = await ctx.testDb.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation_id));
    expect(conv).toBeDefined();
  });
});
