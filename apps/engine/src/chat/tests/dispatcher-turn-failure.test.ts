import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { _setConverseFirstChunkTimeoutMsForTests } from "../../conversations/loop/index.ts";
import {
  type ConversationTestCtx,
  createConversationTestCtx,
} from "../../conversations/tests/setup.ts";
import { chatIdentities, chatWorkspaces, tenants } from "../../db/schema/index.ts";
import { getMockProvider, resetMockProvider } from "../../llm/mock-provider.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import type { ChatAdapter } from "../adapter.ts";
import { handleChatEvent } from "../dispatcher.ts";
import { formatChatText } from "../format/outbound-format.ts";
import { runChatTurnSync } from "../sync-turn.ts";
import type { ApprovalCard, ChatDelivery, ChatEvent, VerifiedEvent } from "../types.ts";

const nextHex = createDeterministicHexFactory(0x7e1a0f);
const detBytes = (n: number): Buffer => Buffer.from(nextHex(n), "hex");

const WORKSPACE = "T_TIMEOUT";
const CHANNEL = "C_TIMEOUT";
const PLATFORM_USER = "U_WAITING";
const TIMEOUT_TEXT = "Timed out after 1 s";

class FakeSlackAdapter implements ChatAdapter {
  readonly platform = "slack" as const;
  sends: ChatDelivery[] = [];
  approvals: ApprovalCard[] = [];
  async verify(): Promise<VerifiedEvent | null> {
    return null;
  }
  async receive(ev: VerifiedEvent): Promise<ChatEvent> {
    return ev as unknown as ChatEvent;
  }
  async send(d: ChatDelivery) {
    this.sends.push(d);
    return { platform_message_id: `msg-${this.sends.length}` };
  }
  async update(_d: ChatDelivery, _id: string) {}
  async sendApproval(c: ApprovalCard) {
    this.approvals.push(c);
    return { platform_message_id: `ap-${this.approvals.length}` };
  }
}

function armSilentModel(): void {
  getMockProvider().setFailure("silent-primary", "stream_never_answers");
}

function mention(thread_id: string, text: string): ChatEvent {
  return {
    platform: "slack",
    workspace_id: WORKSPACE,
    channel_id: CHANNEL,
    thread_id,
    user_id: PLATFORM_USER,
    kind: "mention",
    text: `<@UBOT> ${text}`,
    raw: {},
  };
}

let ctx: ConversationTestCtx;

beforeAll(async () => {
  ctx = await createConversationTestCtx("dispatcher_turn_failure");
  resetMockProvider();
  await ctx.testDb.db
    .update(tenants)
    .set({ llm_primary: "silent-primary", llm_fallback: "silent-fallback" })
    .where(eq(tenants.id, ctx.tenant_id));
  _setConverseFirstChunkTimeoutMsForTests(200);
  await ctx.testDb.db.insert(chatWorkspaces).values({
    tenant_id: ctx.tenant_id,
    platform: "slack",
    workspace_id: WORKSPACE,
    bot_ciphertext: detBytes(1),
    bot_iv: detBytes(1),
    bot_auth_tag: detBytes(1),
  });
  await ctx.testDb.db.insert(chatIdentities).values({
    tenant_id: ctx.tenant_id,
    user_id: ctx.user_id,
    platform: "slack",
    workspace_id: WORKSPACE,
    platform_user_id: PLATFORM_USER,
  });
});

afterAll(async () => {
  _setConverseFirstChunkTimeoutMsForTests(null);
  await ctx.cleanup();
});

describe("chat dispatcher — the model never sends its first chunk", () => {
  test("a new thread gets the timeout wording as its reply and the event completes", async () => {
    const adapter = new FakeSlackAdapter();
    armSilentModel();
    const out = await handleChatEvent(
      { db: ctx.testDb.db, adapter },
      mention("1700000002.000100", "explain why the nightly sync is slow"),
    );
    expect(out.status).toBe("ok");
    expect(out.approval_sent).toBe(false);
    expect(out.conversation_id).toBeTruthy();
    expect(adapter.approvals).toHaveLength(0);
    expect(adapter.sends).toHaveLength(1);
    expect(adapter.sends[0]).toMatchObject({
      kind: "message",
      channel_id: CHANNEL,
      thread_id: "1700000002.000100",
      text: TIMEOUT_TEXT,
    });
  });

  test("a follow-up in the same thread appends to the session and replies with the same wording", async () => {
    const adapter = new FakeSlackAdapter();
    armSilentModel();
    const first = await handleChatEvent(
      { db: ctx.testDb.db, adapter },
      mention("1700000002.000200", "explain why the nightly sync is slow"),
    );
    armSilentModel();
    const second = await handleChatEvent(
      { db: ctx.testDb.db, adapter },
      mention("1700000002.000200", "any idea yet?"),
    );
    expect(second.status).toBe("ok");
    expect(second.conversation_id).toBe(first.conversation_id);
    expect(adapter.sends.map((d) => d.text)).toEqual([TIMEOUT_TEXT, TIMEOUT_TEXT]);
  });

  test("the synchronous webhook path answers with the same text instead of rejecting", async () => {
    const adapter = new FakeSlackAdapter();
    armSilentModel();
    const result = await runChatTurnSync({
      db: ctx.testDb.db,
      adapter,
      event: mention("1700000002.000300", "explain why the nightly sync is slow"),
      timeoutMs: 10_000,
    });
    expect(result).toEqual({ deliver: "sync", text: formatChatText("slack", TIMEOUT_TEXT) });
    expect(adapter.sends).toHaveLength(0);
  });
});
