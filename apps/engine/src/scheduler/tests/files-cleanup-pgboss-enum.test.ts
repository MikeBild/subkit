import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { bootstrapMinimalPgbossSchema } from "./pgboss-bootstrap.ts";

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
    expect(labels).toEqual(
      ["active", "cancelled", "completed", "created", "failed", "retry"].sort(),
    );
  });

  test("inserting state='scheduled' fails (this is the production bug)", async () => {
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
    const err = caught as Error & { cause?: unknown };
    const message = err.message ?? "";
    const causeMessage =
      err.cause instanceof Error ? err.cause.message : err.cause ? String(err.cause) : "";
    const enumHit = `${message}\n${causeMessage}`;
    expect(enumHit).toMatch(/invalid input value for enum/i);
    expect(enumHit).toMatch(/scheduled/);
  });

  test("the in-flight fid scan query runs without an enum-cast error", async () => {
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
    expect(rowsOf(result).length).toBe(0);
  });

  test("pgboss.archive table is gone in pg-boss 12.x (regression guard)", async () => {
    const result = await srv.db.execute(sql`
      SELECT to_regclass('pgboss.archive')::text AS rel
    `);
    const row = rowsOf<{ rel: string | null }>(result)[0];
    expect(row?.rel ?? null).toBeNull();
  });

  test("inserting + selecting each valid state round-trips through the enum", async () => {
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
    await srv.db.execute(sql`DELETE FROM pgboss.job WHERE name = 'test-enum-roundtrip'`);
  });
});
