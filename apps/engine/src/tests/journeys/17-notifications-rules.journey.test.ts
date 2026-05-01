// User story: As an operator, I want execution failures to notify my on-call
// channel with per-channel rate limits and a circuit breaker in front of
// the adapter, so a misbehaving receiver can't drown the engine.
// Acceptance criteria:
//   - AC1: Create notification_channels + notification_rules matching
//          `execution.failed`.
//   - AC2: Register a fake chat adapter that records every call.
//   - AC3: Emit a synthetic `execution.failed` via the outbox.
//   - AC4: Assert adapter received exactly one call.
//   - AC5: Fire 70 events in 1 s; assert the rate limiter dropped >=10.
//   - AC6: Configure the receiver to always throw; 10 consecutive
//          failures open the breaker; next delivery is skipped with
//          `status: "circuit_open"`.
// Spec refs: docs/20-notifications.md, docs/05-events.md

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
import { createJourneyCtx, type JourneyCtx } from "./setup.ts";

/**
 * Minimal `ChatAdapter` stub. Records every call so the test can count
 * deliveries and can flip behaviour mid-test to drive the circuit
 * breaker open. No real Slack/Teams/Google adapter is touched.
 */
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
}, 60_000);

afterAll(async () => {
  if (ctx?.cleanup) await ctx.cleanup();
}, 60_000);

beforeEach(async () => {
  __resetBreakers();
  __resetRateLimiter();
});

describe("journey 17: notifications rules", () => {
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
      // Default capacity of 60 tokens per minute matches the rule.
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
          // Pin `now` so refill math can't accidentally leak tokens
          // into the window under test.
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

    // Drive FAILURE_THRESHOLD back-to-back failures. Every outcome
    // should be `failed` until the breaker opens.
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

    // Next dispatch is gated by the breaker and must not reach the
    // adapter even though `mode` is still `throw`. Stop forcing
    // failures so we can prove the skip comes from the breaker.
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
