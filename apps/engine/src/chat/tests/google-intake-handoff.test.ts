import { afterAll, beforeAll, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createConversation } from "../../conversations/service.ts";
import {
  type ConversationTestCtx,
  createConversationTestCtx,
} from "../../conversations/tests/setup.ts";
import {
  chatIdentities,
  chatSessions,
  chatWorkspaces,
  conversationToolCalls,
} from "../../db/schema/index.ts";
import { createIntakeItem } from "../../knowledge/index.ts";
import { getMockProvider } from "../../llm/mock-provider.ts";
import {
  createDeterministicHexFactory,
  createDeterministicUuidFactory,
} from "../../test-helpers/determinism/ids.ts";
import type { ChatAdapter } from "../adapter.ts";
import { handleChatEvent } from "../dispatcher.ts";
import type { ApprovalCard, ChatDelivery, ChatEvent, VerifiedEvent } from "../types.ts";

const nextHex = createDeterministicHexFactory(0x61a6_1e);
const nextId = createDeterministicUuidFactory(0x61a6_1e);

class FakeGoogleAdapter implements ChatAdapter {
  readonly platform = "google_chat" as const;
  async verify(): Promise<VerifiedEvent | null> {
    return null;
  }
  async receive(event: VerifiedEvent): Promise<ChatEvent> {
    return event as ChatEvent;
  }
  async send(_delivery: ChatDelivery) {
    return { platform_message_id: "google-message" };
  }
  async update(_delivery: ChatDelivery, _platformMessageId: string) {}
  async sendApproval(_card: ApprovalCard) {
    return { platform_message_id: "google-approval" };
  }
}

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("google_intake_handoff");
});

afterAll(async () => {
  await ctx.cleanup();
});

test("Google Chat intake reads hand off the persisted review without admission capability", async () => {
  const workspaceId = "spaces/AAAAintake";
  const channelId = "spaces/AAAAintake";
  const threadId = "spaces/AAAAintake/threads/thread-1";
  const platformUserId = "users/google-intake-user";
  const bytes = Buffer.from(nextHex(12), "hex");
  const [workspace] = await ctx.testDb.db
    .insert(chatWorkspaces)
    .values({
      tenant_id: ctx.tenant_id,
      platform: "google_chat",
      workspace_id: workspaceId,
      bot_ciphertext: bytes,
      bot_iv: bytes,
      bot_auth_tag: bytes,
    })
    .returning();
  if (!workspace) throw new Error("Google workspace seed failed");
  await ctx.testDb.db.insert(chatIdentities).values({
    tenant_id: ctx.tenant_id,
    user_id: ctx.user_id,
    platform: "google_chat",
    workspace_id: workspaceId,
    platform_user_id: platformUserId,
  });
  const item = await createIntakeItem(
    {
      tenant_id: ctx.tenant_id,
      actor: { kind: "user", id: ctx.user_id },
      client_request_id: nextId(),
      category: "inbox",
      title: "Google Chat review source",
      source_url: "https://example.test/google-intake",
      captured_at: "2026-10-10T10:00:00.000Z",
      body: "Collected source content is untrusted.",
    },
    ctx.testDb.db,
  );
  const created = await createConversation(
    {
      tenant_id: ctx.tenant_id,
      actor_id: ctx.user_id,
      origin_client: "chat:google_chat",
      surface: "chat",
    },
    ctx.testDb.db,
  );
  await ctx.testDb.db.insert(chatSessions).values({
    tenant_id: ctx.tenant_id,
    workspace_id: workspace.id,
    thread_id: threadId,
    conversation_id: created.conversation.id,
  });
  getMockProvider().setConversePlan(created.conversation.id, [
    { tool: "list_intake_items", args: {} },
    { tool: "get_intake_item", args: { id: item.id } },
    { text: "I found one collected source to review." },
  ]);

  const result = await handleChatEvent(
    { db: ctx.testDb.db, adapter: new FakeGoogleAdapter() },
    {
      platform: "google_chat",
      workspace_id: workspaceId,
      channel_id: channelId,
      thread_id: threadId,
      user_id: platformUserId,
      kind: "mention",
      text: "Review my collected entries",
      raw: { type: "MESSAGE" },
    },
    { replyDelivery: "capture" },
  );

  expect(result.status).toBe("ok");
  expect(result.conversation_id).toBe(created.conversation.id);
  expect(result.approval_sent).toBe(false);
  expect(result.reply_text).toContain("Continue this review in SubKit: /cockpit/chat/");
  expect(result.reply_text).toContain(
    "Review the exact proposal and confirm it before it becomes knowledge or a skill.",
  );
  const calls = await ctx.testDb.db
    .select({ tool: conversationToolCalls.tool, output: conversationToolCalls.output })
    .from(conversationToolCalls)
    .where(eq(conversationToolCalls.conversation_id, created.conversation.id));
  expect(calls.map((call) => call.tool)).toEqual(["list_intake_items", "get_intake_item"]);
  expect(calls[0]?.output).toMatchObject({ items: [{ id: item.id, title: item.title }] });
  expect(calls[1]?.output).toMatchObject({ item: { id: item.id, title: item.title } });
  expect(calls.some((call) => call.tool === "confirm_intake_proposal")).toBe(false);
  expect(calls.some((call) => call.tool === "create_intake_proposal")).toBe(false);
});
