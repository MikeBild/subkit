import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { auditLog, schedulerSweepCursors, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { acquireSweepPage, recheckSweepCandidate } from "./sweep-cursor.ts";
import { claimSweepCadenceCandidate, readSweepCadenceCandidate } from "./sweep-cursor-claims.ts";
import {
  SWEEP_CADENCE_MS,
  type SweepCadenceProducer,
  sweepCadenceColumn,
} from "./sweep-cursor-source.ts";

const uuid = createDeterministicUuidFactory(0xca0e);
const owner = uuid();
let fixture: TestDb;
beforeAll(async () => {
  fixture = await createTestDb("sweep_cadence");
});
afterAll(async () => {
  await fixture?.cleanup();
});
beforeEach(async () => {
  await fixture.db.delete(tenants);
  await fixture.db.delete(auditLog);
  await fixture.db.update(schedulerSweepCursors).set({
    epoch: 0,
    revision: 0,
    after_id: null,
    epoch_upper_id: null,
    epoch_cutoff_at: null,
    lease_owner_boot_id: null,
    lease_token: null,
    lease_until: null,
    updated_at: sql`date_trunc('milliseconds', clock_timestamp())`,
  });
});
async function candidate(producer: SweepCadenceProducer) {
  const id = uuid();
  await fixture.db.insert(tenants).values({
    id,
    slug: id,
    display_name: "Cadence fixture",
    created_at: new Date(getTestNow() - 60_000),
  });
  const page = await acquireSweepPage(producer, owner, fixture.db);
  if (page.kind !== "claimed")
    throw new Error(`missing cadence fixture page: ${JSON.stringify(page)}`);
  const item = page.candidates[0];
  if (!item) throw new Error("missing cadence fixture candidate");
  return { lease: { ...page.lease, producer }, item };
}

for (const producer of ["drift", "reauth", "endpoint-contract", "skill"] as const) {
  test(`${producer} commits an exact same-transaction cadence claim using the caller's observed time`, async () => {
    const { lease, item } = await candidate(producer);
    const metadata = await readSweepCadenceCandidate(lease, item, fixture.db);
    expect(metadata).toEqual({ kind: "cadence_metadata", expected_at: null });
    const observed = new Date(getTestNow());
    const claimed = await claimSweepCadenceCandidate(lease, item, null, fixture.db, observed);
    expect(claimed).toMatchObject({ kind: "claimed", previous_at: null, claimed_at: observed });
    const column = sweepCadenceColumn(producer);
    const stored = await fixture.db.execute<{ at: string }>(
      sql`SELECT ${column}::text AS at FROM ${tenants} WHERE id = ${item.id}::uuid`,
    );
    expect(new Date(stored.rows[0]?.at ?? "")).toEqual(observed);
    expect(await claimSweepCadenceCandidate(lease, item, null, fixture.db, observed)).toEqual({
      kind: "ineligible",
    });
    const current = await readSweepCadenceCandidate(lease, item, fixture.db);
    if (current.kind !== "cadence_metadata") throw new Error("missing cadence metadata");
    expect(
      await claimSweepCadenceCandidate(
        lease,
        item,
        current.expected_at,
        fixture.db,
        new Date(observed.getTime() + SWEEP_CADENCE_MS[producer]),
      ),
    ).toEqual({ kind: "ineligible" });
    expect(
      (
        await claimSweepCadenceCandidate(
          lease,
          item,
          current.expected_at,
          fixture.db,
          new Date(observed.getTime() + SWEEP_CADENCE_MS[producer] + 1),
        )
      ).kind,
    ).toBe("claimed");
    const entries = await fixture.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "scheduler.sweep_cadence_claimed"));
    expect(entries).toHaveLength(2);
    expect(entries[0]?.metadata).toMatchObject({ operation: "cadence_claim", admitted: 1 });
    expect(JSON.stringify(entries.map((entry) => entry.metadata)).includes(lease.lease_token)).toBe(
      false,
    );
  });
}

test("canonical scalar metadata preserves historical microseconds for exact CAS", async () => {
  const { lease, item } = await candidate("drift");
  await fixture.db.execute(
    sql`UPDATE ${tenants} SET last_proactive_scan_at = ${new Date(getTestNow())}::timestamptz - interval '2 hours' + interval '123 microseconds' WHERE id = ${item.id}::uuid`,
  );
  const read = await readSweepCadenceCandidate(lease, item, fixture.db);
  if (read.kind !== "cadence_metadata" || !read.expected_at)
    throw new Error("missing microsecond metadata");
  expect(read.expected_at).toMatch(/\.\d{3}123[+-]/);
  expect(
    (
      await claimSweepCadenceCandidate(
        lease,
        item,
        read.expected_at,
        fixture.db,
        new Date(getTestNow()),
      )
    ).kind,
  ).toBe("claimed");
});

test("competing actual claims cannot both consume one expected occurrence", async () => {
  const { lease, item } = await candidate("skill");
  const results = await Promise.all([
    claimSweepCadenceCandidate(lease, item, null, fixture.db, new Date(getTestNow())),
    claimSweepCadenceCandidate(lease, item, null, fixture.db, new Date(getTestNow())),
  ]);
  expect(results.filter((result) => result.kind === "claimed")).toHaveLength(1);
  expect(results.filter((result) => result.kind === "ineligible")).toHaveLength(1);
});

test("suspension and stale expected timestamps prevent domain mutation", async () => {
  const { lease, item } = await candidate("reauth");
  const changed = new Date(getTestNow() - SWEEP_CADENCE_MS.reauth * 2);
  await fixture.db
    .update(tenants)
    .set({ last_connector_reauth_scan_at: changed })
    .where(eq(tenants.id, item.id));
  expect(
    await claimSweepCadenceCandidate(lease, item, null, fixture.db, new Date(getTestNow())),
  ).toEqual({ kind: "ineligible" });
  await fixture.db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, item.id));
  const result = await recheckSweepCandidate(lease, item, fixture.db);
  expect(result).toEqual({ kind: "ineligible" });
  expect(
    await claimSweepCadenceCandidate(
      lease,
      item,
      changed.toISOString(),
      fixture.db,
      new Date(getTestNow()),
    ),
  ).toEqual({ kind: "ineligible" });
});

test("a blocked domain row refuses admission without changing its timestamp or audit", async () => {
  const { lease, item } = await candidate("drift");
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = fixture.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM ${tenants} WHERE id = ${item.id}::uuid FOR UPDATE`);
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  let result: Awaited<ReturnType<typeof claimSweepCadenceCandidate>>;
  try {
    result = await claimSweepCadenceCandidate(
      lease,
      item,
      null,
      fixture.db,
      new Date(getTestNow()),
    );
  } finally {
    release.resolve();
    await holder;
  }
  expect(result).toEqual({ kind: "lost_lease" });
  const [stored] = await fixture.db
    .select({ at: tenants.last_proactive_scan_at })
    .from(tenants)
    .where(eq(tenants.id, item.id));
  expect(stored?.at).toBeNull();
  expect(
    await fixture.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, "scheduler.sweep_cadence_claimed")),
  ).toEqual([]);
});

test("claim audit refusal rolls back both cadence state and reservation receipt", async () => {
  const { lease, item } = await candidate("skill");
  await fixture.db.execute(
    sql`CREATE FUNCTION subkit.reject_cadence_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_cadence_audit_refused'; END $$`,
  );
  await fixture.db.execute(
    sql`CREATE TRIGGER reject_cadence_audit BEFORE INSERT ON subkit.audit_log FOR EACH ROW WHEN (NEW.action = 'scheduler.sweep_cadence_claimed') EXECUTE FUNCTION subkit.reject_cadence_audit()`,
  );
  try {
    await expect(
      claimSweepCadenceCandidate(lease, item, null, fixture.db, new Date(getTestNow())),
    ).rejects.toMatchObject({ cause: { message: "fixture_cadence_audit_refused" } });
    const [stored] = await fixture.db
      .select({ at: tenants.last_skill_candidate_analyze_at })
      .from(tenants)
      .where(eq(tenants.id, item.id));
    expect(stored?.at).toBeNull();
  } finally {
    await fixture.db.execute(sql`DROP TRIGGER reject_cadence_audit ON subkit.audit_log`);
    await fixture.db.execute(sql`DROP FUNCTION subkit.reject_cadence_audit()`);
  }
});

test("lease expiry during the SQL-only claim transaction rolls back its timestamp and audit", async () => {
  const { lease, item } = await candidate("skill");
  await fixture.db.execute(
    sql`CREATE FUNCTION subkit.delay_cadence_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.1); RETURN NEW; END $$`,
  );
  await fixture.db.execute(
    sql`CREATE TRIGGER delay_cadence_audit BEFORE INSERT ON subkit.audit_log FOR EACH ROW WHEN (NEW.action = 'scheduler.sweep_cadence_claimed') EXECUTE FUNCTION subkit.delay_cadence_audit()`,
  );
  await fixture.db.execute(sql`WITH observed AS (SELECT date_trunc('milliseconds', clock_timestamp()) AS at)
    UPDATE ${schedulerSweepCursors} SET updated_at = observed.at, lease_until = observed.at + interval '40 milliseconds'
    FROM observed WHERE producer = 'skill'`);
  try {
    expect(
      await claimSweepCadenceCandidate(lease, item, null, fixture.db, new Date(getTestNow())),
    ).toEqual({ kind: "lost_lease" });
    const [stored] = await fixture.db
      .select({ at: tenants.last_skill_candidate_analyze_at })
      .from(tenants)
      .where(eq(tenants.id, item.id));
    expect(stored?.at).toBeNull();
    expect(
      await fixture.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.action, "scheduler.sweep_cadence_claimed")),
    ).toEqual([]);
  } finally {
    await fixture.db.execute(sql`DROP TRIGGER delay_cadence_audit ON subkit.audit_log`);
    await fixture.db.execute(sql`DROP FUNCTION subkit.delay_cadence_audit()`);
  }
});
