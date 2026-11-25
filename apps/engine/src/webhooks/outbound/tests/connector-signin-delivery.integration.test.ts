import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, max } from "drizzle-orm";
import type { Job, PgBoss } from "pg-boss";
import { deliveries, events, outboxCursors } from "../../../db/schema/index.ts";
import {
  callback,
  cockpitSession,
  connectorId,
  server,
  setupConnectorOauth,
} from "../../../http/tests/connector-oauth-fixtures.ts";
import { startListener, stopListener } from "../../../pubsub/listener.ts";
import { createBoss, disposeBoss } from "../../../queue/boss.ts";
import { EVENT_FANOUT_QUEUE } from "../../../queue/handlers/event-fanout.ts";
import { waitFor } from "../../../test-helpers/determinism/wait.ts";
import {
  registerDeliveryWorker,
  WEBHOOK_DELIVER_QUEUE,
  type WebhookDeliverJob,
} from "../delivery-worker.ts";
import { fanoutEventRow } from "../fanout.ts";
import { WEBHOOK_FANOUT_CHANNELS } from "../fanout-channels.ts";
import { type MockReceiver, startMockReceiver } from "./setup.ts";

setupConnectorOauth();

let boss: PgBoss;
let receiver: MockReceiver;

beforeAll(async () => {
  boss = await createBoss({ connectionString: server.testDb.url });
  const listener = await startListener({ connectionString: server.testDb.url, db: server.db });
  for (const channel of WEBHOOK_FANOUT_CHANNELS)
    listener.on(channel, async (event) => {
      await boss.send(EVENT_FANOUT_QUEUE, { event_row_id: event.id });
    });
  receiver = await startMockReceiver();
});

afterAll(async () => {
  await receiver.close();
  await stopListener();
  await disposeBoss(boss);
});

const apiHeaders = () => ({
  authorization: `Bearer ${server.apiKey}`,
  "content-type": "application/json",
});

async function startCockpitSignIn(headers: Record<string, string>): Promise<URL> {
  const res = await fetch(`${server.baseUrl}/v1/connectors/${connectorId}/oauth/start`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
  });
  expect(res.status).toBe(200);
  const { authorization_url } = (await res.json()) as { authorization_url: string };
  return new URL(authorization_url);
}

async function listenerCaughtUp(): Promise<boolean> {
  const [head] = await server.db
    .select({ id: max(events.id) })
    .from(events)
    .where(eq(events.channel, "connector.oauth"));
  const [cursor] = await server.db
    .select({ id: outboxCursors.last_seen_id })
    .from(outboxCursors)
    .where(eq(outboxCursors.channel, "connector.oauth"));
  return head?.id != null && cursor?.id === head.id;
}

async function drainQueue<T extends object>(queue: string): Promise<Job<T>[]> {
  const drained: Job<T>[] = [];
  for (;;) {
    const jobs = (await boss.fetch<T>(queue, { batchSize: 50 })) ?? [];
    if (jobs.length === 0) return drained;
    drained.push(...jobs);
  }
}

describe("connector sign-in outcomes reach an active webhook subscription end to end", () => {
  test("one delivery per finished sign-in, the denial with reason provider_error", async () => {
    const egress = await fetch(`${server.baseUrl}/v1/settings/egress.mode`, {
      method: "PUT",
      headers: apiHeaders(),
      body: JSON.stringify({ value: "permissive" }),
    });
    expect(egress.status).toBe(200);
    const subscriptionRes = await fetch(`${server.baseUrl}/v1/subscriptions`, {
      method: "POST",
      headers: apiHeaders(),
      body: JSON.stringify({
        event_pattern: "connector.oauth.signin_finished",
        target_url: receiver.url,
        secret: "whsec_signinfinisheddeliveryaaaaaa",
      }),
    });
    expect(subscriptionRes.status).toBe(201);
    const subscription = (await subscriptionRes.json()) as { id: string };

    const session = await cockpitSession();
    const allowUrl = await startCockpitSignIn(session.headers);
    const providerRedirect = await fetch(allowUrl, { redirect: "manual" });
    const allowed = await callback(
      new URL(providerRedirect.headers.get("location") ?? "").searchParams.toString(),
    );
    expect(allowed.status).toBe(303);
    const denyUrl = await startCockpitSignIn(session.headers);
    const denied = await callback(`state=${denyUrl.searchParams.get("state")}&error=access_denied`);
    expect(denied.status).toBe(303);

    await waitFor(listenerCaughtUp, { label: "listener caught up", tries: 400, sleepMs: 25 });
    await stopListener();

    const fanoutJobs = await drainQueue<{ event_row_id: number }>(EVENT_FANOUT_QUEUE);
    const fannedOutRowIds = fanoutJobs.map((job) => job.data.event_row_id);
    expect(new Set(fannedOutRowIds).size).toBe(fannedOutRowIds.length);
    for (const job of fanoutJobs) await fanoutEventRow(server.db, boss, job.data.event_row_id);
    const { handle } = await registerDeliveryWorker({
      boss,
      db: server.db,
      fetchImpl: fetch,
      jitter: false,
      noWork: true,
    });
    for (const job of await drainQueue<WebhookDeliverJob>(WEBHOOK_DELIVER_QUEUE)) await handle(job);

    const received = receiver.hits
      .map((hit) => JSON.parse(hit.body) as { type: string; data: Record<string, unknown> })
      .map(({ type, data }) => ({ type, outcome: data.outcome, reason: data.reason }));
    expect(received).toHaveLength(2);
    expect(received).toEqual(
      expect.arrayContaining([
        { type: "connector.oauth.signin_finished", outcome: "succeeded", reason: null },
        { type: "connector.oauth.signin_finished", outcome: "failed", reason: "provider_error" },
      ]),
    );
    const deliveryRows = await server.db
      .select({ status: deliveries.status })
      .from(deliveries)
      .where(
        and(
          eq(deliveries.tenant_id, server.tenantId),
          eq(deliveries.subscription_id, subscription.id),
        ),
      );
    expect(deliveryRows.map((row) => row.status)).toEqual(["success", "success"]);
  });
});
