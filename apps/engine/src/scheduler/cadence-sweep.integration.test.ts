import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { auditLog, schedulerSweepCursors, tenants } from "../db/schema/index.ts";
import { createTestDb, TEST_DB_HOOK_TIMEOUT, type TestDb } from "../db/tests/setup.ts";
import { tenantWorkBootId, tenantWorkSnapshot } from "../execution/tenant-work.ts";
import { createBoss, disposeBoss } from "../queue/boss.ts";
import { SKILL_CANDIDATE_ANALYZE_QUEUE } from "../queue/handlers/skill-candidate-analyze.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import { runTenantCadenceSweep } from "./cadence-sweep.ts";
import { runSkillCandidateAnalysisSweep } from "./skill-candidate-analyze-runner.ts";
import { SWEEP_PAGE_LIMIT } from "./sweep-cursor.ts";

const uuid = createDeterministicUuidFactory(0x5cad123);
const now = new Date(getTestNow());
let fixture: TestDb;
let boss: PgBoss;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

async function seed(count: number) {
  const ids = Array.from({ length: count }, () => uuid()).sort();
  await fixture.db
    .insert(tenants)
    .values(ids.map((id) => ({ id, slug: id, display_name: "Cadence fixture", created_at: now })));
  return ids;
}

beforeAll(async () => {
  fixture = await createTestDb("cadence_sweep");
  boss = await createBoss({ connectionString: fixture.url, schema: "cadence_jobs" });
}, TEST_DB_HOOK_TIMEOUT);
beforeEach(async () => {
  await boss.deleteAllJobs();
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
afterAll(async () => {
  if (boss) await disposeBoss(boss);
  if (fixture) await fixture.cleanup();
}, TEST_DB_HOOK_TIMEOUT);

test("actual public queue SDK receives every tenant across bounded pages and excludes suspended tenants", async () => {
  const ids = await seed(SWEEP_PAGE_LIMIT * 2 + 3);
  const blocked = uuid();
  await fixture.db.insert(tenants).values({
    id: blocked,
    slug: blocked,
    display_name: "Suspended cadence fixture",
    status: "suspended",
    created_at: now,
  });
  for (const expected of [64, 128, 131]) {
    await runSkillCandidateAnalysisSweep(now, fixture.db, boss);
    const jobs = await boss.findJobs<{ tenant_id: string }>(SKILL_CANDIDATE_ANALYZE_QUEUE);
    expect(jobs).toHaveLength(expected);
    expect(new Set(jobs.map((job) => job.data.tenant_id)).size).toBe(expected);
  }
  const jobs = await boss.findJobs<{ tenant_id: string }>(SKILL_CANDIDATE_ANALYZE_QUEUE);
  expect(jobs.map((job) => job.data.tenant_id).sort()).toEqual(ids);
  const rows = await fixture.db.select().from(tenants);
  expect(rows.filter((row) => row.last_skill_candidate_analyze_at !== null)).toHaveLength(
    ids.length,
  );
  expect(rows.find((row) => row.id === blocked)?.last_skill_candidate_analyze_at).toBeNull();
  await runSkillCandidateAnalysisSweep(now, fixture.db, boss);
  expect(await boss.findJobs(SKILL_CANDIDATE_ANALYZE_QUEUE)).toHaveLength(ids.length);
});

test("all cadence families preserve their independent business-time stamps", async () => {
  const ids = await seed(2);
  for (const producer of ["drift", "reauth", "endpoint-contract", "skill"] as const) {
    const visited: string[] = [];
    await runTenantCadenceSweep(producer, now, fixture.db, async (id) => {
      expect(tenantWorkSnapshot(id)).toMatchObject({ boot_id: tenantWorkBootId(), in_flight: 1 });
      visited.push(id);
    });
    expect(visited).toEqual(ids);
    let repeated = 0;
    await runTenantCadenceSweep(producer, now, fixture.db, async () => {
      repeated++;
    });
    expect(repeated).toBe(0);
  }
  const rows = await fixture.db.select().from(tenants);
  for (const row of rows) {
    expect(row.last_proactive_scan_at?.toISOString()).toBe(now.toISOString());
    expect(row.last_connector_reauth_scan_at?.toISOString()).toBe(now.toISOString());
    expect(row.last_endpoint_contract_scan_at?.toISOString()).toBe(now.toISOString());
    expect(row.last_skill_candidate_analyze_at?.toISOString()).toBe(now.toISOString());
    expect(tenantWorkSnapshot(row.id).in_flight).toBe(0);
  }
});

test("an expired cursor never releases a pending producer or admits its old owner's next candidate", async () => {
  const ids = await seed(3);
  const blocked = deferred();
  const entered = deferred();
  const seen: string[] = [];
  const first = runTenantCadenceSweep("drift", now, fixture.db, async (id) => {
    seen.push(id);
    entered.resolve();
    await blocked.promise;
  });
  try {
    await entered.promise;
    expect(tenantWorkSnapshot(ids[0]!).in_flight).toBe(1);
    let concurrent = 0;
    await runTenantCadenceSweep("drift", now, fixture.db, async () => {
      concurrent++;
    });
    expect(concurrent).toBe(0);
    await fixture.db.execute(sql`
      WITH observed AS (SELECT date_trunc('milliseconds', clock_timestamp()) AS at)
      UPDATE ${schedulerSweepCursors} SET updated_at=observed.at-interval '120 seconds',
        lease_until=observed.at-interval '60 seconds'
      FROM observed WHERE producer='drift'
    `);
    await fixture.db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, ids[0]!));
    const recovered: string[] = [];
    await runTenantCadenceSweep("drift", now, fixture.db, async (id) => {
      recovered.push(id);
    });
    expect(recovered).toEqual(ids.slice(1));
    expect(tenantWorkSnapshot(ids[0]!).in_flight).toBe(1);
    blocked.resolve();
    await first;
    expect(seen).toEqual([ids[0]!]);
    expect(tenantWorkSnapshot(ids[0]!).in_flight).toBe(0);
  } finally {
    blocked.resolve();
    await first;
  }
});
