import { afterAll, beforeAll, expect, test } from "bun:test";
import pg from "pg";
import { getConstructionPlans, PgBoss } from "pg-boss";
import { getNextBamCommand } from "pg-boss/dist/plans.js";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";

let fixture: TestDb;
let admin: pg.Client;
let restricted: pg.Client;
let build: pg.Client;
const role = `bam_catalog_reader_${process.pid}`;
const commandId = "5d9f2e39-8958-4d51-a932-5f8b5a179a71";

beforeAll(async () => {
  fixture = await createTestDb("bam_catalog_permissions");
  admin = new pg.Client({ connectionString: fixture.url });
  await admin.connect();
  await admin.query(getConstructionPlans("pgboss"));
  await admin.query(`CREATE ROLE ${role} NOLOGIN`);
  await admin.query(`GRANT USAGE ON SCHEMA pgboss TO ${role}`);
  await admin.query(`GRANT ALL ON ALL TABLES IN SCHEMA pgboss TO ${role}`);
  await admin.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss TO ${role}`);
  await admin.query("REVOKE SELECT ON pg_catalog.pg_database FROM PUBLIC");
  await admin.query("REVOKE SELECT ON pg_catalog.pg_stat_activity FROM PUBLIC");
  restricted = new pg.Client({ connectionString: fixture.url });
  await restricted.connect();
  await restricted.query(`SET ROLE ${role}`);
  build = new pg.Client({ connectionString: fixture.url });
  await build.connect();
});

afterAll(async () => {
  await build?.end();
  await restricted?.end();
  if (admin) {
    await admin.query(`DROP OWNED BY ${role}`);
    await admin.query(`DROP ROLE ${role}`);
    await admin.end();
  }
  await fixture?.cleanup();
});

async function seedStaleCommand(): Promise<void> {
  await admin.query("DELETE FROM pgboss.bam");
  await admin.query(
    `INSERT INTO pgboss.bam (id,name,version,status,table_name,command,started_on)
     VALUES ($1,'restricted-index',1,'in_progress','job','SELECT 1',now()-interval '10 minutes')`,
    [commandId],
  );
}

test("BAM claim works without database or activity catalog access", async () => {
  await expect(restricted.query("SELECT oid FROM pg_catalog.pg_database")).rejects.toMatchObject({
    code: "42501",
  });
  await expect(
    restricted.query("SELECT datid FROM pg_catalog.pg_stat_activity WHERE pid=pg_backend_pid()"),
  ).rejects.toMatchObject({ code: "42501" });
  await seedStaleCommand();
  const claimed = await restricted.query(getNextBamCommand("pgboss", { useLiveness: true }));
  expect(claimed.rows).toHaveLength(1);
  expect(claimed.rows[0]).toMatchObject({
    id: commandId,
    priorStatus: "in_progress",
    reattempt: true,
  });
});

test("a live build lock prevents reclaim even for an old command", async () => {
  await seedStaleCommand();
  await build.query("BEGIN");
  try {
    await build.query("LOCK TABLE pgboss.job IN SHARE UPDATE EXCLUSIVE MODE");
    const claimed = await restricted.query(getNextBamCommand("pgboss", { useLiveness: true }));
    expect(claimed.rows).toHaveLength(0);
    const state = await admin.query(
      "SELECT status,started_on < now()-interval '5 minutes' AS old FROM pgboss.bam WHERE id=$1",
      [commandId],
    );
    expect(state.rows[0]).toEqual({ status: "in_progress", old: true });
  } finally {
    await build.query("ROLLBACK");
  }
  const claimed = await restricted.query(getNextBamCommand("pgboss", { useLiveness: true }));
  expect(claimed.rows).toHaveLength(1);
});

test("a same-relation lock from another database cannot block reclaim", async () => {
  await seedStaleCommand();
  const sql = getNextBamCommand("pgboss", { useLiveness: true }).replace(
    "WITH candidate AS (",
    `WITH pg_locks AS (
       SELECT 'relation'::text AS locktype,true AS granted,'ShareUpdateExclusiveLock'::text AS mode,
              ((SELECT database::bigint FROM pg_catalog.pg_locks WHERE pid=pg_backend_pid() AND database IS NOT NULL AND database<>0 LIMIT 1)+1)::oid AS database,
              'pgboss.job'::regclass::oid AS relation
     ), candidate AS (`,
  );
  await restricted.query("BEGIN");
  try {
    const claimed = await restricted.query(sql);
    expect(claimed.rows).toHaveLength(1);
    expect(claimed.rows[0].id).toBe(commandId);
  } finally {
    await restricted.query("ROLLBACK");
  }
});

test("runtime migration checking and ordinary job processing remain available", async () => {
  const errors: unknown[] = [];
  const boss = new PgBoss({
    connectionString: fixture.url,
    schema: "pgboss",
    schedule: false,
    supervise: false,
    useListenNotify: false,
  });
  boss.on("error", (error) => errors.push(error));
  try {
    await boss.start();
    await boss.createQueue("catalog-permission-contract");
    const id = await boss.send("catalog-permission-contract", { value: "fixture" });
    const jobs = await boss.fetch<{ value: string }>("catalog-permission-contract");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id, data: { value: "fixture" } });
    await boss.complete(
      "catalog-permission-contract",
      jobs.map((job) => job.id),
    );
    expect(await boss.schemaVersion()).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    await boss.stop({ graceful: false, close: true });
  }
});
