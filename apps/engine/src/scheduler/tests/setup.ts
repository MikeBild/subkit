// Scheduler test scaffolding — wraps a queue test ctx with an engine
// context so schedule rows can point at real workflows.

import type { PgBoss } from "pg-boss";
import { createEngineCtx, type EngineTestCtx } from "../../execution/tests/setup.ts";
import { createBoss, disposeBoss } from "../../queue/boss.ts";

export interface SchedulerTestCtx {
  engine: EngineTestCtx;
  boss: PgBoss;
  cleanup: () => Promise<void>;
}

export async function createSchedulerCtx(label: string): Promise<SchedulerTestCtx> {
  const engine = await createEngineCtx(`sched-${label}`);
  const boss = await createBoss({ connectionString: engine.testDb.url });
  return {
    engine,
    boss,
    cleanup: async () => {
      await disposeBoss(boss, 5_000);
      await engine.cleanup();
    },
  };
}
