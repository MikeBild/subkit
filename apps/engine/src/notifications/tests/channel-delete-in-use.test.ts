import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  notificationChannels,
  notificationDeliveries,
  notificationRules,
} from "../../db/schema/notifications.ts";
import type { NotificationActor } from "../admin/actor.ts";
import { ChannelInUseError, deleteChannel, updateChannel } from "../admin/channels.ts";
import { __resetBreakers } from "../circuit-breaker.ts";
import { __resetRateLimiter } from "../rate-limit.ts";
import { dispatchEvent, type NotificationAdapter } from "../service.ts";
import { createNotificationCtx, FakeAdapter, type NotificationTestCtx } from "./setup.ts";

let ctx: NotificationTestCtx;
let actor: NotificationActor;

beforeAll(async () => {
  ctx = await createNotificationCtx("channel_in_use");
  actor = {
    tenant_id: ctx.tenant_id,
    kind: "system_account",
    id: "00000000-0000-4000-8000-000000000609",
  };
});
afterAll(async () => {
  await ctx.cleanup();
});
beforeEach(async () => {
  __resetBreakers();
  __resetRateLimiter();
  await ctx.db.delete(notificationDeliveries);
  await ctx.db.delete(notificationRules);
  await ctx.db.delete(notificationChannels);
});

async function seedChannelWithRule() {
  const [channel] = await ctx.db
    .insert(notificationChannels)
    .values({
      tenant_id: ctx.tenant_id,
      workspace_id: "W_PAUSED",
      channel_id: "C_PAUSED",
      platform: "slack",
    })
    .returning();
  const [rule] = await ctx.db
    .insert(notificationRules)
    .values({
      tenant_id: ctx.tenant_id,
      name: "paused-target",
      event_pattern: "execution.*",
      severity: "info",
      target_workspace_id: "W_PAUSED",
      target_channel_id: "C_PAUSED",
    })
    .returning();
  if (!channel || !rule) throw new Error("seed failed");
  return { channel, rule };
}

function channelRows() {
  return ctx.db
    .select()
    .from(notificationChannels)
    .where(
      and(
        eq(notificationChannels.tenant_id, ctx.tenant_id),
        eq(notificationChannels.workspace_id, "W_PAUSED"),
        eq(notificationChannels.channel_id, "C_PAUSED"),
      ),
    );
}

describe("notifications: deleting a channel that rules still target", () => {
  test("is refused and keeps the paused channel paused after the next event", async () => {
    const { channel } = await seedChannelWithRule();
    await updateChannel(ctx.db, actor, channel.id, { active: false });

    const refusal = await deleteChannel(ctx.db, actor, channel.id).catch((err: unknown) => err);
    expect(refusal).toBeInstanceOf(ChannelInUseError);
    expect((refusal as ChannelInUseError).rule_count).toBe(1);

    const adapter = new FakeAdapter();
    await dispatchEvent(
      { db: ctx.db, resolveAdapter: () => adapter as unknown as NotificationAdapter },
      {
        tenant_id: ctx.tenant_id,
        type: "execution.failed",
        severity: "error",
        request_source: "api",
        payload: {},
      },
    );
    const rows = await channelRows();
    expect(rows.map((row) => ({ id: row.id, active: row.active }))).toEqual([
      { id: channel.id, active: false },
    ]);
    expect(adapter.sends.length).toBe(0);
  });

  test("counts inactive rules too", async () => {
    const { channel, rule } = await seedChannelWithRule();
    await ctx.db
      .update(notificationRules)
      .set({ active: false })
      .where(eq(notificationRules.id, rule.id));
    await expect(deleteChannel(ctx.db, actor, channel.id)).rejects.toBeInstanceOf(
      ChannelInUseError,
    );
  });

  test("succeeds once the targeting rule is gone", async () => {
    const { channel, rule } = await seedChannelWithRule();
    await ctx.db.delete(notificationRules).where(eq(notificationRules.id, rule.id));
    expect(await deleteChannel(ctx.db, actor, channel.id)).toBe(true);
    expect(await channelRows()).toEqual([]);
  });

  test("returns false for an unknown channel", async () => {
    expect(await deleteChannel(ctx.db, actor, "00000000-0000-4000-8000-000000000999")).toBe(false);
  });
});
