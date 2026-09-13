// `runChatTurnSync` — the synchronous Google-Chat response path (F2).
//
// These tests drive the REAL helper against a live test DB (workspace +
// identity + dedup + a real capture-mode turn) to prove the load-bearing
// NO-DOUBLE-SEND invariant end-to-end:
//
//   - fast finish        → { deliver:"sync", text }; the dispatcher sent
//                          NOTHING (capture mode), so the reply has exactly
//                          one sender (the HTTP body the route returns).
//   - dedup already seen → { deliver:"acked" }; the turn never runs, no send.
//   - timeout            → { deliver:"acked" }; the detached turn self-
//                          delivers EXACTLY ONE reply via deliverChatReply.
//   - no workspace       → { deliver:"defer" }; nothing claimed, worker owns it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  type ConversationTestCtx,
  createConversationTestCtx,
} from "../../conversations/tests/setup.ts";
import { chatIdentities, chatWorkspaces } from "../../db/schema/index.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import type { ChatAdapter } from "../adapter.ts";
import { markChatEventSeen } from "../dedup.ts";
import { runChatTurnSync } from "../sync-turn.ts";
import type { ApprovalCard, ChatDelivery, ChatEvent, VerifiedEvent } from "../types.ts";

const nextHex = createDeterministicHexFactory(0x5f2c);
const detBytes = (n: number): Buffer => Buffer.from(nextHex(n), "hex");

class FakeGoogleAdapter implements ChatAdapter {
  readonly platform = "google_chat" as const;
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

const WS = "spaces/AAAA-sync-turn";

let ctx: ConversationTestCtx;
let workspaceUuid: string;

beforeAll(async () => {
  ctx = await createConversationTestCtx("sync-turn");
  const [ws] = await ctx.testDb.db
    .insert(chatWorkspaces)
    .values({
      tenant_id: ctx.tenant_id,
      platform: "google_chat",
      workspace_id: WS,
      bot_ciphertext: detBytes(1),
      bot_iv: detBytes(1),
      bot_auth_tag: detBytes(1),
    })
    .returning();
  if (!ws) throw new Error("seed workspace failed");
  workspaceUuid = ws.id;
  await ctx.testDb.db.insert(chatIdentities).values({
    tenant_id: ctx.tenant_id,
    user_id: ctx.user_id,
    platform: "google_chat",
    workspace_id: WS,
    platform_user_id: "users/sync-1",
  });
});
afterAll(async () => {
  await ctx.cleanup();
});

function mention(channel: string, eventKey: string, text = "hello there"): ChatEvent {
  return {
    platform: "google_chat",
    workspace_id: WS,
    channel_id: channel,
    user_id: "users/sync-1",
    kind: "mention",
    text,
    event_key: eventKey,
    raw: {},
  };
}

describe("runChatTurnSync", () => {
  test("no workspace → defer (nothing claimed, worker owns it)", async () => {
    const adapter = new FakeGoogleAdapter();
    const res = await runChatTurnSync({
      db: ctx.testDb.db,
      adapter,
      event: { ...mention("C_NOWS", "evt-nows"), workspace_id: "spaces/UNREGISTERED" },
      timeoutMs: 20_000,
    });
    expect(res).toEqual({ deliver: "defer" });
    expect(adapter.sends.length).toBe(0);
  });

  test("already-seen event → acked, turn never runs, no send", async () => {
    const eventKey = "evt-dup-1";
    // Claim the dedup row first, exactly as a prior owner (worker or a
    // racing Google retry) would.
    const fresh = await markChatEventSeen(ctx.testDb.db, {
      tenant_id: ctx.tenant_id,
      workspace_id: workspaceUuid,
      platform_event_id: eventKey,
    });
    expect(fresh).toBe(true);

    const adapter = new FakeGoogleAdapter();
    const res = await runChatTurnSync({
      db: ctx.testDb.db,
      adapter,
      event: mention("C_DUP", eventKey),
      timeoutMs: 20_000,
    });
    expect(res).toEqual({ deliver: "acked" });
    // The turn never ran → nothing sent, no card.
    expect(adapter.sends.length).toBe(0);
    expect(adapter.approvals.length).toBe(0);
  });

  test("fast finish → sync with the reply text; dispatcher sent NOTHING (single owner)", async () => {
    const adapter = new FakeGoogleAdapter();
    const res = await runChatTurnSync({
      db: ctx.testDb.db,
      adapter,
      event: mention("C_FAST", "evt-fast-1"),
      timeoutMs: 20_000,
    });
    expect(res.deliver).toBe("sync");
    if (res.deliver !== "sync") throw new Error("expected sync");
    expect(typeof res.text).toBe("string");
    expect(res.text.length).toBeGreaterThan(0);
    // NO-DOUBLE-SEND: in capture mode the dispatcher never posts the
    // terminal reply — the route's HTTP body is the sole delivery.
    expect(adapter.sends.length).toBe(0);
  });

  test("timeout → acked + EXACTLY ONE detached delivery via deliverChatReply", async () => {
    const adapter = new FakeGoogleAdapter();
    // 1ms timeout guarantees the timer wins the race; the turn detaches
    // and self-delivers once it completes.
    const res = await runChatTurnSync({
      db: ctx.testDb.db,
      adapter,
      event: mention("C_SLOW", "evt-slow-1"),
      timeoutMs: 1,
    });
    expect(res).toEqual({ deliver: "acked" });
    // The detached turn delivers exactly one reply after the ack. It is
    // I/O-bound (DB + mock turn), so opt into short real-time polling.
    await waitFor(() => adapter.sends.length >= 1, { sleepMs: 25, label: "detached send" });
    expect(adapter.sends.length).toBe(1);
    expect(adapter.sends[0]?.kind).toBe("message");
    expect((adapter.sends[0]?.text?.length ?? 0) > 0).toBe(true);
    // Prove NO second send ever lands: this poll must TIME OUT (never
    // reach 2). If a duplicate delivery fired, it would resolve and fail.
    await expect(
      waitFor(() => adapter.sends.length >= 2, {
        tries: 6,
        sleepMs: 25,
        label: "no second send",
      }),
    ).rejects.toThrow();
    expect(adapter.sends.length).toBe(1);
  });

  test("missing event_key → treated as fresh (no dedup), still runs once", async () => {
    const adapter = new FakeGoogleAdapter();
    const ev = mention("C_NOKEY", "unused");
    delete (ev as { event_key?: string }).event_key;
    const res = await runChatTurnSync({
      db: ctx.testDb.db,
      adapter,
      event: ev,
      timeoutMs: 20_000,
    });
    expect(res.deliver).toBe("sync");
    expect(adapter.sends.length).toBe(0);
  });
});
