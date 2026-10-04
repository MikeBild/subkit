import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type ConversationTestCtx,
  createConversationTestCtx,
} from "../../conversations/tests/setup.ts";
import { chatWorkspaces } from "../../db/schema/index.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { markChatEventSeen } from "../dedup.ts";

const nextHex = createDeterministicHexFactory(0xdedea7);
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
    const platformEventId = "Ev1234567890";
    const first = await markChatEventSeen(ctx.testDb.db, {
      tenant_id: ctx.tenant_id,
      workspace_id: workspace_row_id,
      platform_event_id: platformEventId,
    });
    expect(first).toBe(true);

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
