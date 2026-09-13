// Unit test for `markChatEventSeen`. Mirrors the
// `webhook_replay_seen` dedup test for inbound webhooks — INSERT ...
// ON CONFLICT DO NOTHING returns true on first insert, false on
// every subsequent attempt with the same key.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  type ConversationTestCtx,
  createConversationTestCtx,
} from "../../conversations/tests/setup.ts";
import { chatWorkspaces } from "../../db/schema/index.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { markChatEventSeen } from "../dedup.ts";

const nextHex = createDeterministicHexFactory(0xdedea7);
/** Deterministic stand-in for `randomBytes(n)` — bytea columns just
 *  need *some* bytes; the deterministic-tests gate forbids
 *  Math.random / crypto.randomBytes. */
const detBytes = (n: number): Buffer => Buffer.from(nextHex(n), "hex");

let ctx: ConversationTestCtx;
let workspace_row_id: string;

beforeAll(async () => {
  ctx = await createConversationTestCtx("chat-dedup");
  const ws = await ctx.testDb.db
    .insert(chatWorkspaces)
    .values({
      tenant_id: ctx.tenant_id,
      platform: "slack",
      workspace_id: "T_DEDUP",
      bot_ciphertext: detBytes(1),
      bot_iv: detBytes(1),
      bot_auth_tag: detBytes(1),
    })
    .returning();
  workspace_row_id = ws[0]!.id;
});
afterAll(async () => {
  await ctx.cleanup();
});

describe("markChatEventSeen", () => {
  test("first insert returns true; replay returns false", async () => {
    // Naming note: this is a Slack platform_event_id, NOT an API
    // credential. A `*_key` suffix on the local would have tripped
    // gitleaks' `generic-api-key` rule and false-failed the secret
    // scan on every push.
    const platformEventId = "Ev1234567890";
    const first = await markChatEventSeen(ctx.testDb.db, {
      tenant_id: ctx.tenant_id,
      workspace_id: workspace_row_id,
      platform_event_id: platformEventId,
    });
    expect(first).toBe(true);

    // Two concurrent retries (Slack ships up to 3× per event) — both
    // see the same key and must drop.
    const [replay1, replay2] = await Promise.all([
      markChatEventSeen(ctx.testDb.db, {
        tenant_id: ctx.tenant_id,
        workspace_id: workspace_row_id,
        platform_event_id: platformEventId,
      }),
      markChatEventSeen(ctx.testDb.db, {
        tenant_id: ctx.tenant_id,
        workspace_id: workspace_row_id,
        platform_event_id: platformEventId,
      }),
    ]);
    expect(replay1).toBe(false);
    expect(replay2).toBe(false);
  });

  test("distinct event_keys do not collide", async () => {
    const ok1 = await markChatEventSeen(ctx.testDb.db, {
      tenant_id: ctx.tenant_id,
      workspace_id: workspace_row_id,
      platform_event_id: "ev-distinct-A",
    });
    const ok2 = await markChatEventSeen(ctx.testDb.db, {
      tenant_id: ctx.tenant_id,
      workspace_id: workspace_row_id,
      platform_event_id: "ev-distinct-B",
    });
    expect(ok1).toBe(true);
    expect(ok2).toBe(true);
  });
});
