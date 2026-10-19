import { expect, test } from "bun:test";
import { runMigrations } from "../migrate.ts";
import { createTestDb } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

test("conversation and mail additions upgrade the existing scheduler lineage without changing it", async () => {
  const scheduler = EMBEDDED_MIGRATIONS.find((entry) =>
    entry.statements.some((statement) =>
      statement.includes('CREATE TABLE "scheduler_sweep_cursors"'),
    ),
  );
  if (!scheduler) throw new Error("scheduler migration missing");
  const fixture = await createTestDb("conversation-mail-upgrade", { upToIdx: scheduler.idx });
  try {
    const original = await fixture.pool.query(
      "SELECT hash,tag,created_at FROM subkit.__drizzle_migrations WHERE tag=$1",
      [scheduler.tag],
    );
    const report = await runMigrations(fixture.db);
    expect(report.applied).toBe(EMBEDDED_MIGRATIONS.length - scheduler.idx - 1);
    expect(report.hash_drift_backfilled).toBe(0);
    expect(
      (
        await fixture.pool.query(
          "SELECT hash,tag,created_at FROM subkit.__drizzle_migrations WHERE tag=$1",
          [scheduler.tag],
        )
      ).rows,
    ).toEqual(original.rows);
    const columns = await fixture.pool.query<{ table_name: string; column_name: string }>(
      "SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='subkit' AND table_name IN ('conversation_turns','transactional_mail_receipts')",
    );
    expect(columns.rows).toContainEqual({
      table_name: "conversation_turns",
      column_name: "cancel_requested",
    });
    expect(columns.rows).toContainEqual({
      table_name: "transactional_mail_receipts",
      column_name: "request_id",
    });
    expect(
      (
        await fixture.pool.query(
          "SELECT tgname FROM pg_trigger WHERE tgrelid='subkit.conversation_turns'::regclass AND NOT tgisinternal",
        )
      ).rows,
    ).toContainEqual({ tgname: "hosted_operational_guard" });
    expect(
      (
        await fixture.pool.query(
          "SELECT count(*)::int AS count FROM subkit.scheduler_sweep_cursors",
        )
      ).rows,
    ).toEqual([{ count: 8 }]);
    expect((await runMigrations(fixture.db)).applied).toBe(0);
  } finally {
    await fixture.cleanup();
  }
});
