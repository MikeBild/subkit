import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PgBoss } from "pg-boss";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createBoss, disposeBoss } from "../boss.ts";

let testDb: TestDb;

const QUEUE = "test.dispose";

beforeAll(async () => {
  testDb = await createTestDb("queue-dispose-boss");
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("queue: disposeBoss", () => {
  test("stops non-gracefully and closes the pool", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const fake = {
      stop: async (options: Record<string, unknown>) => {
        calls.push(options);
      },
    } as unknown as PgBoss;

    await disposeBoss(fake);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({ graceful: false, close: true });
  });

  test("swallows a stop() rejection so teardown never masks the suite result", async () => {
    const fake = {
      stop: async () => {
        throw new Error("pool already destroyed");
      },
    } as unknown as PgBoss;

    await expect(disposeBoss(fake)).resolves.toBeUndefined();
  });

  test("returns promptly while a job is still in flight", async () => {
    const boss = await createBoss({ connectionString: testDb.url });
    await boss.createQueue(QUEUE);
    let handlerEntered: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      handlerEntered = resolve;
    });
    await boss.work(QUEUE, { pollingIntervalSeconds: 1 }, async () => {
      handlerEntered();
      await new Promise(() => {});
    });
    await boss.send(QUEUE, {});
    await inFlight;

    // allow-wall-clock: elapsed real time IS the assertion — a teardown
    // that drains spends its whole budget here.
    const started = Date.now();
    await disposeBoss(boss);
    // allow-wall-clock: the other half of the elapsed-time measurement.
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2_000);
  }, 30_000);
});
