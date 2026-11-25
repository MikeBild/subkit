import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeEvent } from "../../db/events.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { PubSubEmitter } from "../emitter.ts";
import { PubSubListener } from "../listener.ts";

let testDb: TestDb;
let tenantId: string;

beforeAll(async () => {
  testDb = await createTestDb("pubsub-drain-order");
  tenantId = (await seedTenant(testDb.db, { slug: "drain-order", display_name: "Drain order" })).id;
});

afterAll(async () => {
  await testDb.cleanup();
});

test("events written back to back on one channel are each dispatched exactly once", async () => {
  const emitter = new PubSubEmitter();
  const listener = new PubSubListener({
    connectionString: testDb.url,
    db: testDb.db,
    emitter,
    listenerId: "drain-order",
    channels: ["connector.oauth"],
  });
  const dispatchedIds: number[] = [];
  emitter.on("connector.oauth", (event) => {
    dispatchedIds.push(event.id);
  });
  await listener.start();
  try {
    const writtenIds: number[] = [];
    for (const type of [
      "connector.oauth.callback_succeeded",
      "connector.oauth.signin_finished",
      "connector.oauth.signin_finished",
      "connector.oauth.callback_failed",
    ])
      writtenIds.push(
        await writeEvent(testDb.db, {
          tenant_id: tenantId,
          channel: "connector.oauth",
          type,
          payload: {},
        }),
      );
    await waitFor(() => dispatchedIds.length >= writtenIds.length, {
      label: "all events dispatched",
      tries: 400,
      sleepMs: 25,
    });
    await listener.stop();
    expect(dispatchedIds).toEqual(writtenIds);
  } finally {
    await listener.stop();
  }
});
