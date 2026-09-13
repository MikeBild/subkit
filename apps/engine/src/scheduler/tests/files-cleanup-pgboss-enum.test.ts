// Regression test for the `pgboss.job_state` enum drift surfaced in
// 6.2.12 production logs:
//
//   {"level":"error","module":"scheduler",
//    "action":"files_cleanup.pgboss_scan_failed",
//    "error":"...invalid input value for enum pgboss.job_state: \"scheduled\"..."}
//
// Root cause was a code bug, not a version drift: commit 3a6972bc
// added `'scheduled'` to the in-flight scan's state list under the
// (incorrect) assumption that pg-boss has a `scheduled` job_state.
// pg-boss 12.x's `JOB_STATES` enum is exactly six values: `created,
// retry, active, completed, cancelled, failed` (see
// `node_modules/pg-boss/dist/plans.js:8-15`). Long-horizon jobs sit in
// `state = 'created'` with a future `start_after`; cron entries live
// in `pgboss.schedule` (already in the UNION).
//
// The pre-fix tests used a `state text NOT NULL` column in the
// bootstrap helper so the bad query passed locally and failed only in
// prod. The bootstrap helper now installs the real ENUM so any future
// regression of this shape fails fast at the test layer.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";

import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { bootstrapMinimalPgbossSchema } from "./pgboss-bootstrap.ts";

// drizzle's `execute()` returns either a plain array (postgres-js) or
// `{ rows: [...] }` (node-postgres). Mirror the runtime normalisation
// the cleanup runner does at files-cleanup-runner.ts:337-339.
function rowsOf<T>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  if (result && typeof result === "object" && Array.isArray((result as { rows?: T[] }).rows)) {
    return (result as { rows: T[] }).rows;
  }
  return [];
}

let srv: HttpTestServer;

beforeAll(async () => {
  srv = await createHttpTestServer("files-cleanup-pgboss-enum");
  await bootstrapMinimalPgbossSchema(srv.db);
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 30_000);

describe("pgboss.job_state enum — production parity", () => {
  test("bootstrap creates exactly the six pg-boss 12.x states (drift fails fast)", async () => {
    const result = await srv.db.execute(sql`
      SELECT enumlabel::text AS label
      FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE n.nspname = 'pgboss' AND t.typname = 'job_state'
      ORDER BY enumsortorder
    `);
    const labels = rowsOf<{ label: string }>(result)
      .map((r) => r.label)
      .sort();
    // EXACT match — if pg-boss ever adds a new state, update both
    // sides in lockstep so production queries cannot accidentally
    // reference a state the deployed DB doesn't have.
    expect(labels).toEqual(
      ["active", "cancelled", "completed", "created", "failed", "retry"].sort(),
    );
  });

  test("inserting state='scheduled' fails (this is the production bug)", async () => {
    // Mirrors the prod error: `invalid input value for enum
    // pgboss.job_state: "scheduled"`. Asserting it throws here proves
    // the bootstrap actually enforces the enum.
    let caught: unknown = null;
    try {
      await srv.db.execute(sql`
        INSERT INTO pgboss.job (name, state, data)
        VALUES ('execution.run', 'scheduled', '{}'::jsonb)
      `);
    } catch (err) {
      caught = err;
    }
    expect(caught).not.toBeNull();
    // drizzle wraps the postgres error: `message` is `Failed query: ...`
    // and the real enum error is on `cause`. The production log line
    // (`files_cleanup.pgboss_scan_failed`) surfaces both fields. We
    // accept a hit on either so a future drizzle refactor that
    // flattens `cause` into `message` doesn't break the assertion.
    const err = caught as Error & { cause?: unknown };
    const message = err.message ?? "";
    const causeMessage =
      err.cause instanceof Error ? err.cause.message : err.cause ? String(err.cause) : "";
    const enumHit = `${message}\n${causeMessage}`;
    expect(enumHit).toMatch(/invalid input value for enum/i);
    expect(enumHit).toMatch(/scheduled/);
  });

  test("the in-flight fid scan query runs without an enum-cast error", async () => {
    // Mirror of the production SELECT in
    // `apps/engine/src/scheduler/files-cleanup-runner.ts`.
    // Pre-fix this query included `'scheduled'` in the state list
    // and threw `invalid input value for enum pgboss.job_state:
    // "scheduled"`. Post-fix it must run clean against the strict
    // enum. The literal queue name is irrelevant — the table is
    // empty in this test; we only care that the cast succeeds.
    // Also note: the UNION no longer reads `pgboss.archive` — that
    // table is gone in pg-boss 12.x. See the "pgboss.archive table
    // is gone" test below for the regression guard.
    const queueName = "execution.run";
    const result = await srv.db.execute(sql`
      SELECT data::text AS data
      FROM pgboss.job
      WHERE name = ${queueName}
        AND state IN ('created', 'active', 'retry')
      UNION ALL
      SELECT data::text AS data
      FROM pgboss.schedule
    `);
    // Empty tables — just assert the query ran (no enum-cast throw).
    expect(rowsOf(result).length).toBe(0);
  });

  test("pgboss.archive table is gone in pg-boss 12.x (regression guard)", async () => {
    // pg-boss 12.x merged the old `archive` table back into
    // `pgboss.job`. A previous version of `loadInFlightFidStrings`
    // unioned `pgboss.archive` and threw
    // `relation "pgboss.archive" does not exist` in prod once the
    // enum fix unblocked the broader scan path. Pin the absence
    // here so a future bootstrap helper edit cannot re-introduce
    // the bug by silently re-creating the table.
    const result = await srv.db.execute(sql`
      SELECT to_regclass('pgboss.archive')::text AS rel
    `);
    const row = rowsOf<{ rel: string | null }>(result)[0];
    expect(row?.rel ?? null).toBeNull();
  });

  test("inserting + selecting each valid state round-trips through the enum", async () => {
    // Belt-and-braces: prove every state value referenced by the
    // engine query is accepted, by inserting a row for each and
    // counting matches.
    const validStates = ["created", "retry", "active"] as const;
    for (const state of validStates) {
      await srv.db.execute(sql`
        INSERT INTO pgboss.job (name, state, data)
        VALUES ('test-enum-roundtrip', ${state}::pgboss.job_state, '{}'::jsonb)
      `);
    }
    const result = await srv.db.execute(sql`
      SELECT state::text AS state
      FROM pgboss.job
      WHERE name = 'test-enum-roundtrip'
        AND state IN ('created', 'active', 'retry')
    `);
    const got = rowsOf<{ state: string }>(result)
      .map((r) => r.state)
      .sort();
    expect(got).toEqual(["active", "created", "retry"]);
    // Cleanup so subsequent tests in the same describe see a clean state.
    await srv.db.execute(sql`DELETE FROM pgboss.job WHERE name = 'test-enum-roundtrip'`);
  });
});
