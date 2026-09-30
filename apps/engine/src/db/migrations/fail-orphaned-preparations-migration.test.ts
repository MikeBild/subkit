// 0072_fail_orphaned_preparations — a held run refused before its first step
// stayed `queued`, and the preparation lock read it as "in flight" forever.
// The migration fails exactly those rows: held, queued for over an hour, and
// with no queue job that could still pick them up. Run once without the queue
// schema (a fresh install migrates before pg-boss creates it) and once with it.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { executions, tenants } from "../schema/index.ts";
import { createTestDb, type TestDb } from "../tests/setup.ts";
import { EMBEDDED_MIGRATIONS } from "./embedded.ts";

let testDb: TestDb;
let tenantId: string;

const migration = EMBEDDED_MIGRATIONS.find((m) => m.tag === "0072_fail_orphaned_preparations");

async function runMigration(): Promise<void> {
  if (!migration) throw new Error("migration 0072_fail_orphaned_preparations is not embedded");
  for (const statement of migration.statements) await testDb.db.execute(sql.raw(statement));
}

async function seed(row: {
  hold_writes: boolean;
  status: "queued" | "running";
  ageMinutes: number;
}): Promise<string> {
  const [inserted] = await testDb.db
    .insert(executions)
    .values({
      tenant_id: tenantId,
      source_kind: "draft",
      hold_writes: row.hold_writes,
      status: row.status,
      request_source: "ui",
      execution_mode: "dev",
      // Set on insert: a held row's boundary cannot be changed afterwards.
      created_at: sql`now() - make_interval(mins => ${row.ageMinutes})`,
    })
    .returning({ id: executions.id });
  if (!inserted) throw new Error("seed execution failed");
  return inserted.id;
}

async function stateOf(id: string) {
  const [row] = await testDb.db
    .select({ status: executions.status, failure: executions.failure })
    .from(executions)
    .where(eq(executions.id, id));
  return row;
}

beforeAll(async () => {
  testDb = await createTestDb("fail_orphaned_preparations");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "t-orphaned-prep", display_name: "Orphaned preparations" })
    .returning();
  if (!tenant) throw new Error("seed tenant failed");
  tenantId = tenant.id;
});

afterAll(async () => {
  await testDb.cleanup();
});

describe("0072_fail_orphaned_preparations", () => {
  test("without the queue schema: fails stale held queued rows, leaves the rest", async () => {
    await testDb.db.execute(sql.raw("DROP SCHEMA IF EXISTS pgboss CASCADE"));
    const orphan = await seed({ hold_writes: true, status: "queued", ageMinutes: 120 });
    const fresh = await seed({ hold_writes: true, status: "queued", ageMinutes: 10 });
    const live = await seed({ hold_writes: false, status: "queued", ageMinutes: 120 });
    const running = await seed({ hold_writes: true, status: "running", ageMinutes: 120 });

    await runMigration();

    expect(await stateOf(orphan)).toEqual({
      status: "failed",
      failure: {
        step_id: null,
        error_code: "orphaned_preparation",
        error_message: "The preparation was refused before it started and never ran.",
      },
    });
    expect((await stateOf(fresh))?.status).toBe("queued");
    expect((await stateOf(live))?.status).toBe("queued");
    expect((await stateOf(running))?.status).toBe("running");
  });

  test("with the queue schema: a row a queue job can still pick up is left alone", async () => {
    await testDb.db.execute(sql.raw("CREATE SCHEMA IF NOT EXISTS pgboss"));
    await testDb.db.execute(
      sql.raw("CREATE TABLE IF NOT EXISTS pgboss.job (id uuid NOT NULL, name text NOT NULL)"),
    );
    const orphan = await seed({ hold_writes: true, status: "queued", ageMinutes: 120 });
    const enqueued = await seed({ hold_writes: true, status: "queued", ageMinutes: 120 });
    await testDb.db.execute(
      sql`INSERT INTO pgboss.job (id, name) VALUES (${enqueued}, 'execution.run')`,
    );

    await runMigration();

    expect((await stateOf(orphan))?.status).toBe("failed");
    expect((await stateOf(orphan))?.failure?.error_code).toBe("orphaned_preparation");
    expect((await stateOf(enqueued))?.status).toBe("queued");
  });
});
