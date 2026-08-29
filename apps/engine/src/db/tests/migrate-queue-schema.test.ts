import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createBoss, disposeBoss } from "../../queue/boss.ts";
import { runMigrations } from "../migrate.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT } from "./setup.ts";

describe("queue schema isolation migration", () => {
  test(
    "preserves existing queue state and remains restartable",
    async () => {
      const ctx = await createTestDb("migrate_queue_schema", { upToIdx: 40 });
      try {
        const before = await createBoss({ connectionString: ctx.url });
        const jobId = await before.send("execution.run", { migration_probe: true });
        expect(jobId).toBeString();
        await disposeBoss(before);

        const report = await runMigrations(ctx.db);
        expect(report.applied).toBe(2);

        const schemas = (await ctx.db.execute(sql`
          SELECT to_regnamespace('pgboss') IS NOT NULL AS canonical,
                 to_regnamespace('subkit_queue') IS NOT NULL AS transitional
        `)) as unknown as { rows: Array<{ canonical: boolean; transitional: boolean }> };
        expect(schemas.rows[0]).toEqual({ canonical: true, transitional: false });

        const preserved = (await ctx.db.execute(sql`
          SELECT count(*)::int AS n FROM pgboss.job WHERE id = ${jobId}::uuid
        `)) as unknown as { rows: Array<{ n: number }> };
        expect(preserved.rows[0]?.n).toBe(1);

        const after = await createBoss({ connectionString: ctx.url });
        await disposeBoss(after);
      } finally {
        await ctx.cleanup();
      }
    },
    TEST_DB_HOOK_TIMEOUT,
  );
});
