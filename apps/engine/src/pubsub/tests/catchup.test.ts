// Simulate a listener disconnect: stop the listener, write events into
// the outbox, then start a fresh listener. Catch-up should deliver the
// missed rows before LISTEN is issued.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeEvent } from "../../db/events.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { PubSubEmitter } from "../emitter.ts";
import { PubSubListener } from "../listener.ts";
import type { EventEnvelope } from "../types.ts";

let testDb: TestDb;
let tenantId: string;

beforeAll(async () => {
  testDb = await createTestDb("pubsub-catchup");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "catchup-co", display_name: "Catchup Co" })
    .returning();
  tenantId = tenant!.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("pubsub listener catch-up", () => {
  test("missed events are delivered via cursor replay after reconnect", async () => {
    const firstEmitter = new PubSubEmitter();
    const firstListener = new PubSubListener({
      connectionString: testDb.url,
      db: testDb.db,
      emitter: firstEmitter,
      listenerId: "catchup-listener",
      channels: ["execution.status"],
    });
    const firstReceived: EventEnvelope[] = [];
    firstEmitter.on("execution.status", (e) => {
      firstReceived.push(e as EventEnvelope);
    });
    await firstListener.start();

    // Write one event with the first listener alive — should land.
    await testDb.db.transaction(async (tx) => {
      await writeEvent(tx, {
        tenant_id: tenantId,
        channel: "execution.status",
        type: "execution.started",
        payload: { execution_id: "exec-a" },
      });
    });
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const d1 = Date.now() + 5_000;
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    while (Date.now() < d1 && firstReceived.length < 1) {
      await new Promise((r) => setTimeout(r, 50)); // allow-wall-clock: pub/sub catch-up propagation across the listener boundary
    }
    expect(firstReceived.length).toBe(1);

    // Simulate a disconnect.
    await firstListener.stop();

    // Write 3 events while there is no live listener.
    await testDb.db.transaction(async (tx) => {
      await writeEvent(tx, {
        tenant_id: tenantId,
        channel: "execution.status",
        type: "execution.running",
        payload: { execution_id: "exec-a" },
      });
      await writeEvent(tx, {
        tenant_id: tenantId,
        channel: "execution.status",
        type: "execution.succeeded",
        payload: { execution_id: "exec-a" },
      });
      await writeEvent(tx, {
        tenant_id: tenantId,
        channel: "execution.status",
        type: "execution.queued",
        payload: { execution_id: "exec-b" },
      });
    });

    // New listener with the same id — should pick up via cursor.
    const secondEmitter = new PubSubEmitter();
    const secondListener = new PubSubListener({
      connectionString: testDb.url,
      db: testDb.db,
      emitter: secondEmitter,
      listenerId: "catchup-listener",
      channels: ["execution.status"],
    });
    const secondReceived: EventEnvelope[] = [];
    secondEmitter.on("execution.status", (e) => {
      secondReceived.push(e as EventEnvelope);
    });
    await secondListener.start();

    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    const d2 = Date.now() + 5_000;
    // allow-wall-clock: this test exercises real-time polling or freshness windows.
    while (Date.now() < d2 && secondReceived.length < 3) {
      await new Promise((r) => setTimeout(r, 50)); // allow-wall-clock: pub/sub catch-up propagation across the listener boundary
    }

    await secondListener.stop();

    expect(secondReceived.length).toBe(3);
    const types = secondReceived.map((e) => e.type).sort();
    expect(types).toEqual(["execution.queued", "execution.running", "execution.succeeded"]);
  });
});
