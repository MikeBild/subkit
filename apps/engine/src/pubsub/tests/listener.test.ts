// writeEvent -> NOTIFY -> listener hydrates event -> local handler sees it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { writeEvent } from "../../db/events.ts";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { PubSubEmitter } from "../emitter.ts";
import { PubSubListener } from "../listener.ts";
import type { EventEnvelope } from "../types.ts";

let testDb: TestDb;
let listener: PubSubListener;
let emitter: PubSubEmitter;
let tenantId: string;

beforeAll(async () => {
  testDb = await createTestDb("pubsub-listener");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "pubsub-co", display_name: "Pub/Sub Co" })
    .returning();
  tenantId = tenant!.id;
  emitter = new PubSubEmitter();
  listener = new PubSubListener({
    connectionString: testDb.url,
    db: testDb.db,
    emitter,
    listenerId: "test-listener-1",
    channels: ["execution.status"],
  });
  await listener.start();
});

afterAll(async () => {
  await listener.stop();
  await testDb.cleanup();
});

describe("pubsub listener", () => {
  test("notify payload routes through the emitter to local handlers", async () => {
    const received: EventEnvelope[] = [];
    const unsub = emitter.on("execution.status", (e) => {
      received.push(e as EventEnvelope);
    });

    await testDb.db.transaction(async (tx) => {
      await writeEvent(tx, {
        tenant_id: tenantId,
        channel: "execution.status",
        type: "execution.started",
        payload: { execution_id: "exec-listener-1" },
      });
    });

    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && received.length < 1) {
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0]?.channel).toBe("execution.status");
    expect(received[0]?.type).toBe("execution.started");
    expect((received[0]?.payload as { execution_id: string }).execution_id).toBe("exec-listener-1");

    unsub();
  });
});
