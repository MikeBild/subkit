// Verify pg-boss retries a failing job per the queue config and that the
// dead-letter queue receives the payload after the retries are
// exhausted. To keep the test fast we create a custom queue with a very
// low retry count + zero delay.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Job, PgBoss } from "pg-boss";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createBoss, disposeBoss } from "../boss.ts";

let testDb: TestDb;
let boss: PgBoss;

const QUEUE = "test.retry";
const DLQ = "test.retry.dlq";

beforeAll(async () => {
  testDb = await createTestDb("queue-retry");
  boss = await createBoss({ connectionString: testDb.url });
  await boss.createQueue(DLQ);
  await boss.createQueue(QUEUE, {
    retryLimit: 2,
    retryDelay: 0,
    retryBackoff: false,
    deadLetter: DLQ,
  });
});

afterAll(async () => {
  await disposeBoss(boss, 5_000);
  await testDb.cleanup();
});

describe("queue: retries and dead-letter", () => {
  test("failing job retries, then lands in the dead-letter queue", async () => {
    let attempts = 0;
    const doneResolvers: Array<() => void> = [];
    const donePromise = new Promise<void>((resolve) => doneResolvers.push(resolve));

    interface BoomJob {
      boom: true;
    }
    await boss.work<BoomJob>(
      QUEUE,
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async (_jobs: Job<BoomJob>[]) => {
        attempts += 1;
        throw new Error(`attempt ${attempts} crashed`);
      },
    );

    // Also watch the DLQ; once a row lands there, resolve.
    await boss.work<BoomJob>(
      DLQ,
      { batchSize: 1, pollingIntervalSeconds: 0.5 },
      async (_jobs: Job<BoomJob>[]) => {
        for (const r of doneResolvers) r();
      },
    );

    await boss.send(QUEUE, { boom: true });

    // Bounded wait so the test can't hang.
    const guard = new Promise<void>(
      (_resolve, reject) => setTimeout(() => reject(new Error("dlq never got the job")), 20_000), // allow-wall-clock: legacy; review before changing
    );
    await Promise.race([donePromise, guard]);

    // attempts must be retryLimit + 1 (initial attempt + retries).
    expect(attempts).toBeGreaterThanOrEqual(3);
  }, 30_000);
});
