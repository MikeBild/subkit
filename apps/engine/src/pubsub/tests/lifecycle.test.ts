import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeEvent } from "../../db/events.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { PubSubEmitter } from "../emitter.ts";
import { getListener, PubSubListener, startListener, stopListener } from "../listener.ts";
import type { OutboxChannel } from "../types.ts";

let tdb: TestDb;
let tenantId: string;

beforeAll(async () => {
  tdb = await createTestDb("pubsub-lifecycle");
  const [tenant] = await tdb.db
    .insert(tenants)
    .values({ slug: "listener-lifecycle", display_name: "Listener lifecycle" })
    .returning();
  if (!tenant) throw new Error("tenant fixture missing");
  tenantId = tenant.id;
});

afterAll(async () => {
  await tdb.cleanup();
});

async function otherConnections(): Promise<number> {
  const result = await tdb.pool.query(
    "SELECT count(*)::int AS count FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
  );
  return result.rows[0].count;
}

test("stopping during catch-up closes the session and prevents late connection publication", async () => {
  await tdb.db.transaction((tx) =>
    writeEvent(tx, {
      tenant_id: tenantId,
      channel: "execution.status",
      type: "execution.started",
      payload: {},
    }),
  );
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  const emitter = new PubSubEmitter();
  emitter.on("execution.status", async () => {
    entered.resolve();
    await released.promise;
  });
  const baseline = await otherConnections();
  const listener = new PubSubListener({
    connectionString: tdb.url,
    db: tdb.db,
    emitter,
    listenerId: "stop-during-catchup",
    channels: ["execution.status"],
  });
  const starting = listener.start();
  await entered.promise;
  const stopping = listener.stop();
  released.resolve();
  await Promise.all([starting, stopping]);
  expect(listener.isConnected()).toBe(false);
  expect(await otherConnections()).toBe(baseline);
});

test("a failed LISTEN closes its database session before start rejects", async () => {
  const baseline = await otherConnections();
  const listener = new PubSubListener({
    connectionString: tdb.url,
    db: tdb.db,
    listenerId: "failed-listen",
    channels: ['invalid"channel' as OutboxChannel],
  });
  await expect(listener.start()).rejects.toThrow();
  expect(listener.isConnected()).toBe(false);
  expect(await otherConnections()).toBe(baseline);
  await listener.stop();
});

test("a terminated listener reconnects and delivers committed events", async () => {
  const emitter = new PubSubEmitter();
  let received = false;
  emitter.on("execution.status", () => {
    received = true;
  });
  const listener = new PubSubListener({
    connectionString: tdb.url,
    db: tdb.db,
    emitter,
    listenerId: "terminated-listener",
    channels: ["execution.status"],
  });
  try {
    await listener.start();
    received = false;
    const sessions = await tdb.pool.query(
      "SELECT pid FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()",
    );
    expect(sessions.rows).toHaveLength(1);
    await tdb.pool.query("SELECT pg_terminate_backend($1)", [sessions.rows[0].pid]);
    await waitFor(() => !listener.isConnected(), { sleepMs: 10, label: "listener disconnect" });
    await tdb.db.transaction((tx) =>
      writeEvent(tx, {
        tenant_id: tenantId,
        channel: "execution.status",
        type: "execution.started",
        payload: {},
      }),
    );
    await waitFor(() => listener.isConnected() && received, {
      sleepMs: 10,
      label: "listener reconnect and replay",
    });
  } finally {
    await listener.stop();
  }
  expect(listener.isConnected()).toBe(false);
});

test("a failed singleton start can be retried with a healthy listener", async () => {
  await expect(
    startListener({
      connectionString: tdb.url,
      db: tdb.db,
      channels: ['invalid"channel' as OutboxChannel],
    }),
  ).rejects.toThrow();
  expect(() => getListener()).toThrow("has not been started");
  try {
    const listener = await startListener({
      connectionString: tdb.url,
      db: tdb.db,
      channels: ["execution.status"],
    });
    expect(listener.isConnected()).toBe(true);
  } finally {
    await stopListener();
  }
});
