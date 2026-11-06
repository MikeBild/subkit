import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { auditLog, catalogCategories, schedulerSweepCursors, tenants } from "../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../db/tests/setup.ts";
import { tenantWorkSnapshot } from "../execution/tenant-work.ts";
import { createBoss, disposeBoss } from "../queue/boss.ts";
import {
  CATALOG_DESCRIBE_QUEUE,
  enqueueCatalogDescribe,
} from "../queue/handlers/catalog-describe.ts";
import { FROZEN_NOW } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { seedTenant } from "../test-helpers/seed.ts";
import { runCatalogDescribeSweep } from "./catalog-describe-runner.ts";
import {
  acquireSweepPage,
  releaseSweepLease,
  SWEEP_PAGE_LIMIT,
  withLiveSweepLease,
} from "./sweep-cursor.ts";

const uuid = createDeterministicUuidFactory(0xcada10);
let fixture: TestDb;
let boss: PgBoss;
beforeAll(async () => {
  fixture = await createTestDb("catalog_sweep");
  boss = await createBoss({ connectionString: fixture.url });
}, TEST_DB_HOOK_TIMEOUT);
afterAll(async () => {
  if (boss) await disposeBoss(boss);
  if (fixture) await fixture.cleanup();
}, TEST_DB_HOOK_TIMEOUT);
beforeEach(async () => {
  await boss.deleteAllJobs(CATALOG_DESCRIBE_QUEUE);
  await fixture.db.delete(tenants);
  await fixture.db.delete(auditLog);
  await fixture.db
    .update(schedulerSweepCursors)
    .set({
      epoch: 0,
      revision: 0,
      after_id: null,
      epoch_upper_id: null,
      epoch_cutoff_at: null,
      lease_owner_boot_id: null,
      lease_token: null,
      lease_until: null,
      updated_at: sql`date_trunc('milliseconds',clock_timestamp())`,
    })
    .where(eq(schedulerSweepCursors.producer, "catalog"));
});
async function tenant(pending = true) {
  const id = uuid();
  await seedTenant(fixture.db, {
    id,
    slug: id,
    display_name: "Catalog sweep fixture",
    created_at: new Date(FROZEN_NOW),
  });
  if (pending)
    await fixture.db
      .insert(catalogCategories)
      .values({ tenant_id: id, name: "pending category", purpose_pending: true });
  return id;
}
async function entries() {
  return fixture.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "scheduler.sweep_queue_admitted"));
}
async function state() {
  return (
    await fixture.db
      .select()
      .from(schedulerSweepCursors)
      .where(eq(schedulerSweepCursors.producer, "catalog"))
  )[0]!;
}

test("real SDK jobs cover more than two durable pages without repeats or tenant multiplication", async () => {
  const ids = await Promise.all(Array.from({ length: SWEEP_PAGE_LIMIT * 2 + 5 }, () => tenant()));
  let attempts = 0;
  while (
    (await boss.findJobs<{ tenant_id: string }>(CATALOG_DESCRIBE_QUEUE)).length < ids.length &&
    attempts < 8
  ) {
    attempts++;
    await runCatalogDescribeSweep(fixture.db, boss);
    const jobs = await boss.findJobs<{ tenant_id: string }>(CATALOG_DESCRIBE_QUEUE);
    expect(new Set(jobs.map((job) => job.data.tenant_id)).size).toBe(jobs.length);
    expect((await entries()).length).toBe(jobs.length);
  }
  expect(attempts).toBeGreaterThanOrEqual(3);
  expect(await boss.findJobs(CATALOG_DESCRIBE_QUEUE)).toHaveLength(ids.length);
  expect((await state()).epoch_upper_id).toBeNull();
  expect(
    (await boss.findJobs<{ tenant_id: string }>(CATALOG_DESCRIBE_QUEUE))
      .map((job) => job.data.tenant_id)
      .sort(),
  ).toEqual(ids.sort());
}, 60_000);

test("production standard policy coalesces repeated pending catalog admissions", async () => {
  const id = await tenant();
  const first = await enqueueCatalogDescribe(boss, { tenant_id: id });
  const second = await enqueueCatalogDescribe(boss, { tenant_id: id });
  expect(first).toBeString();
  expect(second).toBeNull();
  expect(await boss.findJobs(CATALOG_DESCRIBE_QUEUE)).toHaveLength(1);
});

test("active catalog work admits one coalesced successor", async () => {
  const id = await tenant();
  expect(await enqueueCatalogDescribe(boss, { tenant_id: id })).toBeString();
  expect(await boss.fetch(CATALOG_DESCRIBE_QUEUE)).toHaveLength(1);
  const results = await Promise.all([
    enqueueCatalogDescribe(boss, { tenant_id: id }),
    enqueueCatalogDescribe(boss, { tenant_id: id }),
  ]);
  expect(results.filter((result) => result !== null)).toHaveLength(1);
  expect(await boss.findJobs(CATALOG_DESCRIBE_QUEUE)).toHaveLength(2);
});

test("explicit isolated short policy records real singleton null as existing", async () => {
  await boss.deleteQueue(CATALOG_DESCRIBE_QUEUE);
  await boss.createQueue(CATALOG_DESCRIBE_QUEUE, { policy: "short" });
  try {
    const id = await tenant();
    await tenant(false);
    const inactive = await tenant();
    await fixture.db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, inactive));
    const existing = await enqueueCatalogDescribe(boss, { tenant_id: id });
    expect(existing).toBeString();
    await runCatalogDescribeSweep(fixture.db, boss);
    expect(await boss.findJobs(CATALOG_DESCRIBE_QUEUE)).toHaveLength(1);
    expect((await entries()).map((row) => row.metadata)).toEqual([
      {
        request_source: "scheduler",
        producer: "catalog",
        epoch: 1,
        revision: 1,
        outcome: "no_new_job",
      },
    ]);
  } finally {
    await boss.deleteQueue(CATALOG_DESCRIBE_QUEUE);
    await boss.createQueue(CATALOG_DESCRIBE_QUEUE);
  }
});

test("database default and sub-millisecond birth timestamps remain eligible", async () => {
  const id = uuid();
  await seedTenant(fixture.db, { id, slug: id, display_name: "Default birth fixture" });
  await fixture.db
    .insert(catalogCategories)
    .values({ tenant_id: id, name: "pending default", purpose_pending: true });
  const precise = await tenant();
  await fixture.db.execute(
    sql`UPDATE ${tenants} SET created_at=date_trunc('milliseconds',clock_timestamp())-interval '1 second'+interval '456 microseconds' WHERE id=${precise}`,
  );
  await runCatalogDescribeSweep(fixture.db, boss);
  expect(
    (await boss.findJobs<{ tenant_id: string }>(CATALOG_DESCRIBE_QUEUE))
      .map((job) => job.data.tenant_id)
      .sort(),
  ).toEqual([id, precise].sort());
});

test("queue send is tracked and tenant status cannot change inside the atomic admission", async () => {
  const id = await tenant();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const upsert = boss.upsert.bind(boss);
  boss.upsert = (async (...args: Parameters<PgBoss["upsert"]>) => {
    const result = await upsert(...args);
    entered.resolve();
    await release.promise;
    return result;
  }) as PgBoss["upsert"];
  const running = runCatalogDescribeSweep(fixture.db, boss);
  try {
    await entered.promise;
    expect(tenantWorkSnapshot(id).in_flight).toBe(1);
    const client = await fixture.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='50ms'");
      await expect(
        client.query("UPDATE subkit.tenants SET status='suspended' WHERE id=$1", [id]),
      ).rejects.toMatchObject({ code: "55P03" });
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    expect(await boss.findJobs(CATALOG_DESCRIBE_QUEUE)).toHaveLength(0);
  } finally {
    release.resolve();
    await running;
    boss.upsert = upsert;
  }
  expect(await boss.findJobs(CATALOG_DESCRIBE_QUEUE)).toHaveLength(1);
  expect(tenantWorkSnapshot(id).in_flight).toBe(0);
});

test("status change committed after page discovery blocks admission at the tenant lock", async () => {
  const id = await tenant();
  const client = await fixture.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("UPDATE subkit.tenants SET status='suspended' WHERE id=$1", [id]);
    await runCatalogDescribeSweep(fixture.db, boss);
    expect(await boss.findJobs(CATALOG_DESCRIBE_QUEUE)).toHaveLength(0);
    expect(await entries()).toHaveLength(0);
    expect(tenantWorkSnapshot(id).in_flight).toBe(0);
  } finally {
    await client.query("COMMIT");
    client.release();
  }
  await runCatalogDescribeSweep(fixture.db, boss);
  expect(await boss.findJobs(CATALOG_DESCRIBE_QUEUE)).toHaveLength(0);
});

test("stale owner cannot enqueue after another live owner takes over", async () => {
  const id = await tenant();
  const first = await acquireSweepPage("catalog", uuid(), fixture.db);
  if (first.kind !== "claimed") throw new Error("missing first page");
  await fixture.db.execute(
    sql`UPDATE ${schedulerSweepCursors} SET updated_at=date_trunc('milliseconds',clock_timestamp())-interval '120 seconds',lease_until=date_trunc('milliseconds',clock_timestamp())-interval '60 seconds' WHERE producer='catalog'`,
  );
  const second = await acquireSweepPage("catalog", uuid(), fixture.db);
  if (second.kind !== "claimed") throw new Error("missing second page");
  expect(
    await withLiveSweepLease(first.lease, fixture.db, (tx) =>
      enqueueCatalogDescribe(boss, { tenant_id: id }, tx),
    ),
  ).toEqual({ kind: "lost_lease" });
  await runCatalogDescribeSweep(fixture.db, boss);
  expect(await boss.findJobs(CATALOG_DESCRIBE_QUEUE)).toHaveLength(0);
  await releaseSweepLease(second.lease, fixture.db);
  await runCatalogDescribeSweep(fixture.db, boss);
  expect(await boss.findJobs(CATALOG_DESCRIBE_QUEUE)).toHaveLength(1);
});

test("mandatory admission audit failure rolls the real SDK insertion back", async () => {
  await tenant();
  await fixture.pool.query(
    "CREATE FUNCTION subkit.test_catalog_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='scheduler.sweep_queue_admitted' THEN RAISE EXCEPTION 'synthetic_catalog_audit_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_catalog_audit_failure BEFORE INSERT ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.test_catalog_audit_failure()",
  );
  try {
    await runCatalogDescribeSweep(fixture.db, boss);
    expect(await boss.findJobs(CATALOG_DESCRIBE_QUEUE)).toHaveLength(0);
    expect(await entries()).toHaveLength(0);
  } finally {
    await fixture.pool.query(
      "DROP TRIGGER test_catalog_audit_failure ON subkit.audit_log; DROP FUNCTION subkit.test_catalog_audit_failure()",
    );
  }
  await runCatalogDescribeSweep(fixture.db, boss);
  expect(await boss.findJobs(CATALOG_DESCRIBE_QUEUE)).toHaveLength(1);
});

test("lease expiration after real SDK insertion rolls back queue and admission receipt", async () => {
  await tenant();
  await fixture.pool.query(
    "CREATE FUNCTION subkit.test_catalog_short_lease() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='scheduler.sweep_claimed' THEN UPDATE subkit.scheduler_sweep_cursors SET updated_at=date_trunc('milliseconds',clock_timestamp()),lease_until=date_trunc('milliseconds',clock_timestamp())+interval '300 milliseconds' WHERE producer='catalog'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_catalog_short_lease AFTER INSERT ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.test_catalog_short_lease()",
  );
  const upsert = boss.upsert.bind(boss);
  let sends = 0;
  boss.upsert = (async (...args: Parameters<PgBoss["upsert"]>) => {
    const result = await upsert(...args);
    sends++;
    await fixture.pool.query("SELECT pg_sleep(0.4)");
    return result;
  }) as PgBoss["upsert"];
  try {
    await runCatalogDescribeSweep(fixture.db, boss);
    expect(sends).toBe(1);
    expect(await boss.findJobs(CATALOG_DESCRIBE_QUEUE)).toHaveLength(0);
    expect(await entries()).toHaveLength(0);
    expect((await state()).after_id).toBeNull();
  } finally {
    boss.upsert = upsert;
    await fixture.pool.query(
      "DROP TRIGGER test_catalog_short_lease ON subkit.audit_log; DROP FUNCTION subkit.test_catalog_short_lease()",
    );
  }
});
