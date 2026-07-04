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

  // #6: a brand-new / unseen consumer (e.g. the first boot after adopting
  // the stable "engine" id, or any renamed consumer) must NOT re-dispatch
  // the entire outbox. loadCursor seeds a missing cursor from the highest
  // watermark any prior consumer reached on the channel, so a fresh consumer
  // starts at "now", not at id 0.
  test("a new consumer seeds from the high-water mark, not 0 (no historical replay)", async () => {
    // Consumer A processes 2 events → its cursor advances to the 2nd id.
    const emitterA = new PubSubEmitter();
    const listenerA = new PubSubListener({
      connectionString: testDb.url,
      db: testDb.db,
      emitter: emitterA,
      listenerId: "hwm-consumer-A",
      channels: ["execution.status"],
    });
    const receivedA: EventEnvelope[] = [];
    emitterA.on("execution.status", (e) => {
      receivedA.push(e as EventEnvelope);
    });
    await listenerA.start();
    await testDb.db.transaction(async (tx) => {
      await writeEvent(tx, {
        tenant_id: tenantId,
        channel: "execution.status",
        type: "execution.started",
        payload: { execution_id: "hwm-1" },
      });
      await writeEvent(tx, {
        tenant_id: tenantId,
        channel: "execution.status",
        type: "execution.started",
        payload: { execution_id: "hwm-2" },
      });
    });
    // allow-wall-clock: this test exercises real-time listener catch-up.
    const dA = Date.now() + 5_000;
    // allow-wall-clock: this test exercises real-time listener catch-up.
    while (Date.now() < dA && receivedA.length < 2) {
      await new Promise((r) => setTimeout(r, 50)); // allow-wall-clock: catch-up propagation
    }
    await listenerA.stop();
    expect(receivedA.length).toBeGreaterThanOrEqual(2);

    // A genuinely NEW consumer id with no cursor row. Pre-fix it would seed
    // from 0 and replay every event on the channel; with the watermark seed
    // it starts at A's watermark and sees nothing new.
    const emitterB = new PubSubEmitter();
    const listenerB = new PubSubListener({
      connectionString: testDb.url,
      db: testDb.db,
      emitter: emitterB,
      listenerId: "hwm-consumer-B-fresh",
      channels: ["execution.status"],
    });
    const receivedB: EventEnvelope[] = [];
    emitterB.on("execution.status", (e) => {
      receivedB.push(e as EventEnvelope);
    });
    await listenerB.start();
    // Give catch-up a chance to (wrongly) replay if the bug were present.
    await new Promise((r) => setTimeout(r, 1500)); // allow-wall-clock: would-be replay window
    await listenerB.stop();
    expect(receivedB.length).toBe(0);
  });
});
