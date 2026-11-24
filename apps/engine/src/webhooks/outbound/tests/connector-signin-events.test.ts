import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, asc, eq, inArray } from "drizzle-orm";
import { events } from "../../../db/schema/index.ts";
import {
  signalSignInFailed,
  signalSignInSucceeded,
} from "../../../http/routes/connectors/signin-signals.ts";
import { WEBHOOK_DELIVER_QUEUE, type WebhookDeliverJob } from "../delivery-worker.ts";
import { fanoutEventRow } from "../fanout.ts";
import { WEBHOOK_FANOUT_CHANNELS } from "../fanout-channels.ts";
import { createOutboundCtx, type OutboundTestCtx } from "./setup.ts";

const CONNECTOR_ID = "33333333-3333-4333-8333-333333333333";
const CONNECTOR_SLUG = "google-gmail";

let ctx: OutboundTestCtx;

beforeAll(async () => {
  ctx = await createOutboundCtx("connector-signin");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("connector sign-in events reach webhook subscriptions", () => {
  test("every channel a subscribable catalog event is written on is fanned out", () => {
    expect([...WEBHOOK_FANOUT_CHANNELS]).toEqual(
      expect.arrayContaining(["execution.status", "notification.emitted", "connector.oauth"]),
    );
  });

  test("a failed and a succeeded sign-in each enqueue one delivery for signin_finished", async () => {
    const subscription = await ctx.createSub({
      event_pattern: "connector.oauth.signin_finished",
      target_url: "http://127.0.0.1:0/ignored",
      secret: "whsec_signinfinishedaaaaaaaaaaaa",
    });
    await signalSignInFailed(ctx.db, {
      module: "test",
      tenant_id: ctx.tenantId,
      connector_id: CONNECTOR_ID,
      connector_slug: CONNECTOR_SLUG,
      reason: "provider_error",
    });
    await signalSignInSucceeded(ctx.db, {
      module: "test",
      tenant_id: ctx.tenantId,
      connector_id: CONNECTOR_ID,
      connector_slug: CONNECTOR_SLUG,
      has_refresh_token: true,
    });
    const fannedOutRows = await ctx.db
      .select()
      .from(events)
      .where(
        and(
          eq(events.tenant_id, ctx.tenantId),
          inArray(events.channel, [...WEBHOOK_FANOUT_CHANNELS]),
        ),
      )
      .orderBy(asc(events.id));
    for (const row of fannedOutRows) await fanoutEventRow(ctx.db, ctx.boss, row.id);
    const deliverJobs =
      (await ctx.boss.fetch<WebhookDeliverJob>(WEBHOOK_DELIVER_QUEUE, { batchSize: 10 })) ?? [];
    expect(deliverJobs.every((job) => job.data.subscription_id === subscription.id)).toBe(true);
    expect(
      deliverJobs.every((job) => job.data.event_type === "connector.oauth.signin_finished"),
    ).toBe(true);
    const deliveredOutcomes = deliverJobs
      .map((job) => JSON.parse(job.data.body).data)
      .map(({ outcome, reason }) => ({ outcome, reason }));
    expect(deliveredOutcomes).toHaveLength(2);
    expect(deliveredOutcomes).toEqual(
      expect.arrayContaining([
        { outcome: "failed", reason: "provider_error" },
        { outcome: "succeeded", reason: null },
      ]),
    );
    for (const job of deliverJobs) await ctx.boss.complete(WEBHOOK_DELIVER_QUEUE, job.id);
  });
});
