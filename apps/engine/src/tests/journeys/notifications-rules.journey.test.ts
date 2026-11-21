import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { ChatAdapter } from "../../chat/adapter.ts";
import type { ApprovalCard, ChatDelivery, ChatEvent, VerifiedEvent } from "../../chat/types.ts";
import {
  notificationChannels,
  notificationDeliveries,
  notificationRules,
} from "../../db/schema/notifications.ts";
import { __resetBreakers, FAILURE_THRESHOLD } from "../../notifications/circuit-breaker.ts";
import type { NotificationEvent } from "../../notifications/matcher.ts";
import { __resetRateLimiter } from "../../notifications/rate-limit.ts";
import { dispatchEvent, type NotificationAdapter } from "../../notifications/service.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx } from "./setup.ts";

class RecordingAdapter implements ChatAdapter {
  readonly platform = "slack" as const;
  readonly sends: ChatDelivery[] = [];
  readonly approvals: ApprovalCard[] = [];
  mode: "ok" | "throw" = "ok";

  async verify(): Promise<VerifiedEvent | null> {
    return null;
  }
  async receive(ev: VerifiedEvent): Promise<ChatEvent> {
    return ev as unknown as ChatEvent;
  }
  async send(d: ChatDelivery): Promise<{ platform_message_id: string }> {
    if (this.mode === "throw") throw new Error("stub: receiver down");
    this.sends.push(d);
    return { platform_message_id: `rec-${this.sends.length}` };
  }
  async update(_d: ChatDelivery, _id: string): Promise<void> {}
  async sendApproval(c: ApprovalCard): Promise<{ platform_message_id: string }> {
    this.approvals.push(c);
    return { platform_message_id: `ap-${this.approvals.length}` };
  }
}

let ctx: JourneyCtx;

async function wipeNotificationState(): Promise<void> {
  await ctx.db.delete(notificationDeliveries);
  await ctx.db.delete(notificationRules);
  await ctx.db.delete(notificationChannels);
  __resetBreakers();
  __resetRateLimiter();
}

async function seedChannelAndRule(params: {
  workspace: string;
  channel: string;
  rate_limit_per_minute?: number;
}): Promise<void> {
  await ctx.db.insert(notificationChannels).values({
    tenant_id: ctx.tenantId,
    workspace_id: params.workspace,
    channel_id: params.channel,
    platform: "slack",
    rate_limit_per_minute: params.rate_limit_per_minute ?? 60,
  });
  await ctx.db.insert(notificationRules).values({
    tenant_id: ctx.tenantId,
    name: "on-call-failures",
    event_pattern: "execution.failed",
    severity: "info",
    target_workspace_id: params.workspace,
    target_channel_id: params.channel,
  });
}

function syntheticFailureEvent(): NotificationEvent {
  return {
    tenant_id: ctx.tenantId,
    type: "execution.failed",
    severity: "error",
    request_source: "api",
    payload: {
      reason: "synthetic_failure",
      workflow_id: "00000000-0000-0000-0000-00000000ffff",
    },
    workflow_id: "00000000-0000-0000-0000-00000000ffff",
  };
}

beforeAll(async () => {
  ctx = await createJourneyCtx("notif-rules");
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

beforeEach(async () => {
  __resetBreakers();
  __resetRateLimiter();
});

describe("notifications rules", () => {
  test("AC1-AC4: matching rule delivers exactly one event through the fake adapter", async () => {
    await wipeNotificationState();
    await seedChannelAndRule({ workspace: "W_ONCALL", channel: "C_ALERTS" });

    const adapter = new RecordingAdapter();

    const result = await dispatchEvent(
      { db: ctx.db, resolveAdapter: () => adapter as unknown as NotificationAdapter },
      syntheticFailureEvent(),
    );
    expect(result.matched).toBe(1);
    expect(result.delivered).toBe(1);
    expect(adapter.sends.length).toBe(1);
    expect(adapter.sends[0]?.workspace_id).toBe("W_ONCALL");
    expect(adapter.sends[0]?.channel_id).toBe("C_ALERTS");

    const deliveries = await ctx.db
      .select()
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.tenant_id, ctx.tenantId),
          eq(notificationDeliveries.status, "sent"),
        ),
      );
    expect(deliveries.length).toBe(1);
  });

  test("AC5: 70 events in 1 s ⇒ rate limiter drops ≥ 10", async () => {
    await wipeNotificationState();
    await seedChannelAndRule({
      workspace: "W_RATE",
      channel: "C_BURST",
      rate_limit_per_minute: 60,
    });

    const adapter = new RecordingAdapter();
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const t0 = Date.now();

    let dropped = 0;
    let delivered = 0;
    for (let i = 0; i < 70; i += 1) {
      const r = await dispatchEvent(
        {
          db: ctx.db,
          resolveAdapter: () => adapter as unknown as NotificationAdapter,
          now: () => t0,
        },
        syntheticFailureEvent(),
      );
      if (r.outcomes[0]?.status === "rate_limited") dropped += 1;
      if (r.outcomes[0]?.status === "sent") delivered += 1;
    }
    expect(delivered).toBe(60);
    expect(dropped).toBeGreaterThanOrEqual(10);

    const limitedRows = await ctx.db
      .select()
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.tenant_id, ctx.tenantId),
          eq(notificationDeliveries.status, "rate_limited"),
        ),
      );
    expect(limitedRows.length).toBeGreaterThanOrEqual(10);
  });

  test("AC6: 10 consecutive failures open the breaker; next delivery is circuit_open", async () => {
    await wipeNotificationState();
    await seedChannelAndRule({ workspace: "W_BREAK", channel: "C_BREAK" });

    const adapter = new RecordingAdapter();
    adapter.mode = "throw";

    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const t0 = Date.now();
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) {
      const r = await dispatchEvent(
        {
          db: ctx.db,
          resolveAdapter: () => adapter as unknown as NotificationAdapter,
          now: () => t0,
        },
        syntheticFailureEvent(),
      );
      expect(r.outcomes[0]?.status).toBe("failed");
    }

    const [channel] = await ctx.db
      .select()
      .from(notificationChannels)
      .where(eq(notificationChannels.workspace_id, "W_BREAK"));
    expect(channel?.circuit_state).toBe("open");
    expect(channel?.consecutive_failures).toBe(FAILURE_THRESHOLD);

    adapter.mode = "ok";
    const sentBefore = adapter.sends.length;
    const blocked = await dispatchEvent(
      {
        db: ctx.db,
        resolveAdapter: () => adapter as unknown as NotificationAdapter,
        now: () => t0 + 1_000,
      },
      syntheticFailureEvent(),
    );
    expect(blocked.delivered).toBe(0);
    expect(blocked.outcomes[0]?.status).toBe("breaker_open");
    expect(blocked.outcomes[0]?.reason).toBe("circuit_open");
    expect(adapter.sends.length).toBe(sentBefore);
  });
});
