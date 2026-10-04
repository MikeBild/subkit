import type { PgBoss } from "pg-boss";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createBoss, disposeBoss } from "../boss.ts";

export interface QueueTestCtx {
  testDb: TestDb;
  boss: PgBoss;
  cleanup: () => Promise<void>;
}

export async function createQueueCtx(label: string): Promise<QueueTestCtx> {
  const testDb = await createTestDb(`queue-${label}`);
  const boss = await createBoss({ connectionString: testDb.url });
  return {
    testDb,
    boss,
    cleanup: async () => {
      await disposeBoss(boss);
      await testDb.cleanup();
    },
  };
}
