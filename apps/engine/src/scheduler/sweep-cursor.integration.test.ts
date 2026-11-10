import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import type { Db } from "../db/client.ts";
import * as schema from "../db/schema/index.ts";
import {
  auditLog,
  schedulerSweepCursors,
  schedulerSweepProducerEnum,
  tenants,
} from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { tenantWorkInFlight, withTenantWork } from "../execution/index.ts";
import { FROZEN_NOW } from "../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../test-helpers/determinism/ids.ts";
import {
  acquireSweepPage,
  completeSweepEpoch,
  recheckSweepCandidate,
  releaseSweepLease,
  renewSweepLease,
  SWEEP_METADATA_MAX_BYTES,
  SWEEP_PAGE_LIMIT,
  type SweepAcquireResult,
  walkSweepPage,
  withLiveSweepLease,
} from "./sweep-cursor.ts";

const uuid = createDeterministicUuidFactory(0x5c0e);
const firstOwner = uuid();
const secondOwner = uuid();
let fixture: TestDb;

function claimed(result: SweepAcquireResult) {
  if (result.kind !== "claimed") throw new Error(`expected claimed sweep, received ${result.kind}`);
  return result;
}
async function tenantRows(count: number) {
  const ids = Array.from({ length: count }, () => uuid());
  await fixture.db.insert(tenants).values(
    ids.map((id) => ({
      id,
      slug: id,
      display_name: "Sweep fixture",
      created_at: new Date(FROZEN_NOW),
    })),
  );
  return ids.sort();
}
async function expire(producer = "catalog") {
  await fixture.db.execute(sql`WITH observed AS (SELECT date_trunc('milliseconds', clock_timestamp()) AS at)
    UPDATE ${schedulerSweepCursors} SET updated_at = observed.at - interval '120 seconds',
      lease_until = observed.at - interval '60 seconds'
    FROM observed WHERE producer = ${producer}`);
}
async function state() {
  return (
    await fixture.db
      .select()
      .from(schedulerSweepCursors)
      .where(eq(schedulerSweepCursors.producer, "catalog"))
  )[0];
}

async function waitForBlockedBackend(pid: number, blockerPid: number, signal: AbortSignal) {
  const deadline = AbortSignal.timeout(1_000);
  while (!signal.aborted && !deadline.aborted) {
    const result = await fixture.db.execute<{
      wait_event_type: string | null;
      blockers: number[];
    }>(sql`SELECT wait_event_type, pg_blocking_pids(pid) AS blockers
      FROM pg_stat_activity WHERE pid = ${pid}`);
    const row = result.rows[0];
    if (row?.wait_event_type === "Lock" && row.blockers.includes(blockerPid)) return;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (!signal.aborted) throw new Error(`backend ${pid} did not block on a lock`);
}

beforeAll(async () => {
  fixture = await createTestDb("sweep_cursor");
});
afterAll(async () => {
  await fixture?.cleanup();
});
beforeEach(async () => {
  await fixture.db.delete(tenants);
  await fixture.db.delete(auditLog);
  await fixture.db
    .insert(schedulerSweepCursors)
    .values(schedulerSweepProducerEnum.enumValues.map((producer) => ({ producer })))
    .onConflictDoNothing();
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

test("empty epochs stay idle and persist a fixed atomic completion receipt", async () => {
  expect(await acquireSweepPage("catalog", firstOwner, fixture.db)).toEqual({
    kind: "empty",
    epoch: 1,
    revision: 1,
  });
  expect(await state()).toMatchObject({
    epoch: 1,
    revision: 1,
    epoch_cutoff_at: null,
    lease_token: null,
  });
  const entries = await fixture.db.select().from(auditLog);
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    resource_type: "scheduler_sweep",
    resource_id: "catalog",
    actor_type: "system",
  });
  expect(entries[0]?.metadata).toMatchObject({
    producer: "catalog",
    epoch: 1,
    revision: 1,
    request_source: "scheduler",
    operation: "complete",
    outcome: "empty",
  });
});

test("metadata pages are bounded and the owned walker resumes a complete multi-page traversal", async () => {
  const ids = await tenantRows(SWEEP_PAGE_LIMIT * 2 + 3);
  const seen: string[] = [];
  for (let index = 0; index < 3; index++) {
    const page = claimed(await acquireSweepPage("catalog", firstOwner, fixture.db));
    expect(page.candidates.length).toBeLessThanOrEqual(SWEEP_PAGE_LIMIT);
    expect(Buffer.byteLength(JSON.stringify(page.candidates))).toBeLessThanOrEqual(
      SWEEP_METADATA_MAX_BYTES,
    );
    expect(Object.keys(page.candidates[0] ?? {}).sort()).toEqual(["created_at", "id", "tenant_id"]);
    const result = await walkSweepPage(page, fixture.db, async (candidate) => {
      seen.push(candidate.id);
      return "visited";
    });
    expect(result).toMatchObject({
      visited: page.candidates.length,
      admitted: 0,
      skipped: page.candidates.length,
      failed: 0,
    });
    expect(result.kind).toBe("walked");
    if (result.kind !== "walked") throw new Error("unexpected lost traversal");
    if (index < 2) {
      expect(await completeSweepEpoch(result.lease, fixture.db)).toEqual({ kind: "not_exhausted" });
      expect(await releaseSweepLease(result.lease, fixture.db)).toEqual({ kind: "released" });
    } else {
      expect(await completeSweepEpoch(result.lease, fixture.db)).toEqual({ kind: "completed" });
    }
  }
  expect(seen).toEqual(ids);
  const completions = await fixture.db
    .select()
    .from(auditLog)
    .where(eq(auditLog.action, "scheduler.sweep_completed"));
  expect(completions).toHaveLength(1);
  expect(completions[0]?.metadata).toMatchObject({ operation: "complete", outcome: "complete" });
  expect(await state()).toMatchObject({
    epoch: 1,
    after_id: null,
    lease_token: null,
    epoch_upper_id: null,
  });
});

test("deferred tails and failed first candidates do not skip or pin the rest of the page", async () => {
  const ids = await tenantRows(3);
  const page = claimed(await acquireSweepPage("catalog", firstOwner, fixture.db));
  let attempted = 0;
  const first = await walkSweepPage(page, fixture.db, async () => {
    attempted++;
    if (attempted === 1) throw new Error("fixture candidate failed");
    return "deferred";
  });
  expect(first).toMatchObject({ kind: "walked", visited: 1, failed: 1 });
  if (first.kind !== "walked") throw new Error("unexpected lost traversal");
  expect((await state())?.after_id).toBe(ids[0]);
  await releaseSweepLease(first.lease, fixture.db);
  const resumed = claimed(await acquireSweepPage("catalog", firstOwner, fixture.db));
  expect(resumed.candidates.map((candidate) => candidate.id)).toEqual(ids.slice(1));
});

test("a cloned page cannot pretend that an arbitrary ID was visited", async () => {
  await tenantRows(2);
  const page = claimed(await acquireSweepPage("catalog", firstOwner, fixture.db));
  await expect(walkSweepPage({ ...page }, fixture.db, async () => "visited")).rejects.toMatchObject(
    { code: "sweep_page_unowned" },
  );
  expect((await state())?.after_id).toBeNull();
});

test("busy ownership and contended cursor row locks return without mutation", async () => {
  await tenantRows(1);
  const page = claimed(await acquireSweepPage("catalog", firstOwner, fixture.db));
  const before = await state();
  expect(await acquireSweepPage("catalog", secondOwner, fixture.db)).toEqual({ kind: "busy" });
  expect(await state()).toEqual(before);
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = fixture.db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT producer FROM ${schedulerSweepCursors} WHERE producer = 'catalog' FOR UPDATE`,
    );
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  try {
    expect(await acquireSweepPage("catalog", secondOwner, fixture.db)).toEqual({ kind: "busy" });
  } finally {
    release.resolve();
    await holder;
  }
  expect(await releaseSweepLease(page.lease, fixture.db)).toEqual({ kind: "released" });
});

test("a busy contender does not make a committed owner lose its lease", async () => {
  const [tenantId] = await tenantRows(1);
  if (!tenantId) throw new Error("missing fixture tenant");
  const page = claimed(await acquireSweepPage("catalog", firstOwner, fixture.db));
  const candidate = page.candidates[0];
  if (!candidate) throw new Error("missing fixture candidate");
  const contenderReady = Promise.withResolvers<number>();
  const releaseContender = Promise.withResolvers<void>();
  const contenderDb = new Proxy(fixture.db, {
    get(target, property, receiver) {
      if (property !== "transaction") return Reflect.get(target, property, receiver);
      return async (run: Parameters<Db["transaction"]>[0]) =>
        target.transaction(async (tx) => {
          try {
            const result = await run(tx);
            const pid = Number(
              (await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`)).rows[0]?.pid,
            );
            if (!Number.isInteger(pid)) throw new Error("missing contender backend pid");
            contenderReady.resolve(pid);
            await releaseContender.promise;
            return result;
          } catch (error) {
            contenderReady.reject(error);
            throw error;
          }
        });
    },
  }) as Db;
  const contender = acquireSweepPage("catalog", secondOwner, contenderDb);
  let ownerClient: PoolClient | undefined;
  let rechecked: ReturnType<typeof recheckSweepCandidate> | undefined;
  let observation: AbortController | undefined;
  let blocked: Promise<void> | undefined;
  let checked: Awaited<ReturnType<typeof recheckSweepCandidate>> | undefined;
  let cleanupFailure: unknown;
  try {
    const contenderBackendPid = await Promise.race([
      contenderReady.promise,
      contender.then(() => {
        throw new Error("contender settled before the lock barrier");
      }),
    ]);
    ownerClient = await fixture.pool.connect();
    const ownerDb = drizzle(ownerClient, { schema });
    const ownerPid = Number(
      (await ownerClient.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]?.pid,
    );
    if (!Number.isInteger(ownerPid)) throw new Error("missing owner backend pid");
    rechecked = recheckSweepCandidate(page.lease, candidate, ownerDb);
    observation = new AbortController();
    blocked = waitForBlockedBackend(ownerPid, contenderBackendPid, observation.signal);
    const observed = await Promise.race([
      blocked.then(() => "blocked" as const),
      rechecked.then(() => "settled" as const),
    ]);
    expect(observed).toBe("blocked");
  } finally {
    releaseContender.resolve();
    observation?.abort();
    const settled = await Promise.allSettled([
      contender,
      ...(blocked ? [blocked] : []),
      ...(rechecked ? [rechecked] : []),
    ]);
    ownerClient?.release();
    const rejected = settled.find((result) => result.status === "rejected");
    if (rejected?.status === "rejected") cleanupFailure = rejected.reason;
    if (rechecked && !cleanupFailure) checked = await rechecked;
  }
  if (cleanupFailure) throw cleanupFailure;
  expect(await contender).toEqual({ kind: "busy" });
  expect(checked).toEqual({
    kind: "eligible_metadata",
    candidate: expect.objectContaining({
      id: candidate.id,
      tenant_id: tenantId,
    }),
  });
});

test("renewal invalidates stale same-owner revisions and expiry takeover preserves the epoch range", async () => {
  await tenantRows(2);
  const page = claimed(await acquireSweepPage("catalog", firstOwner, fixture.db));
  const renewed = await renewSweepLease(page.lease, fixture.db);
  expect(renewed.kind).toBe("renewed");
  expect(await releaseSweepLease(page.lease, fixture.db)).toEqual({ kind: "lost_lease" });
  await expire();
  const taken = claimed(await acquireSweepPage("catalog", secondOwner, fixture.db));
  expect(taken.lease.epoch).toBe(page.lease.epoch);
  expect(taken.lease.epoch_upper_id).toBe(page.lease.epoch_upper_id);
  expect(taken.lease.epoch_cutoff_at).toEqual(page.lease.epoch_cutoff_at);
  expect(taken.lease.lease_token === page.lease.lease_token).toBe(false);
  const candidate = page.candidates[0];
  if (!candidate) throw new Error("missing fixture candidate");
  expect(await recheckSweepCandidate(page.lease, candidate, fixture.db)).toEqual({
    kind: "lost_lease",
  });
});

test("actual pending tenant work settles after takeover without admitting another stale candidate", async () => {
  await tenantRows(2);
  const page = claimed(await acquireSweepPage("catalog", firstOwner, fixture.db));
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  let calls = 0;
  const walking = walkSweepPage(page, fixture.db, async (candidate) =>
    withTenantWork(candidate.tenant_id, async () => {
      calls++;
      started.resolve();
      await finish.promise;
      return "visited" as const;
    }),
  );
  await started.promise;
  try {
    expect(tenantWorkInFlight()).toBe(1);
    await expire();
    expect((await acquireSweepPage("catalog", secondOwner, fixture.db)).kind).toBe("claimed");
    expect(tenantWorkInFlight()).toBe(1);
  } finally {
    finish.resolve();
  }
  expect(await walking).toEqual({ kind: "lost_lease" });
  expect(tenantWorkInFlight()).toBe(0);
  expect(calls).toBe(1);
});

test("new births within the UUID range wait for the next finite epoch", async () => {
  const ids = await tenantRows(2);
  const page = claimed(await acquireSweepPage("catalog", firstOwner, fixture.db));
  const inserted = uuid();
  await fixture.db.insert(tenants).values({
    id: inserted,
    slug: inserted,
    display_name: "Later birth",
    created_at: new Date(page.lease.epoch_cutoff_at.getTime() + 1),
  });
  const seen: string[] = [];
  const result = await walkSweepPage(page, fixture.db, async (candidate) => {
    seen.push(candidate.id);
    return "visited";
  });
  expect(seen).toEqual(ids);
  if (result.kind !== "walked") throw new Error("unexpected lost traversal");
  expect(await completeSweepEpoch(result.lease, fixture.db)).toEqual({ kind: "completed" });
  const next = claimed(await acquireSweepPage("catalog", firstOwner, fixture.db));
  expect(next.lease.epoch).toBe(2);
  expect(next.candidates.map((candidate) => candidate.id)).toContain(inserted);
});

test("candidate lifecycle is rechecked before the trusted visitor runs", async () => {
  await tenantRows(1);
  const page = claimed(await acquireSweepPage("catalog", firstOwner, fixture.db));
  await fixture.db.update(tenants).set({ status: "suspended" });
  let calls = 0;
  const result = await walkSweepPage(page, fixture.db, async () => {
    calls++;
    return "visited";
  });
  expect(result).toMatchObject({ kind: "walked", visited: 1, skipped: 1 });
  expect(calls).toBe(0);
});

test("effective operator query and lock deadlines are never lengthened", async () => {
  await tenantRows(1);
  const client = await fixture.pool.connect();
  const database = drizzle(client, { schema });
  try {
    await client.query("SET statement_timeout = '1s'");
    await client.query("SET lock_timeout = '50ms'");
    const page = claimed(await acquireSweepPage("catalog", firstOwner, database));
    const deadlines = await withLiveSweepLease(page.lease, database, async (tx) => {
      const result = await tx.execute<{ statement_timeout: string; lock_timeout: string }>(
        sql`SELECT current_setting('statement_timeout') AS statement_timeout, current_setting('lock_timeout') AS lock_timeout`,
      );
      return result.rows[0];
    });
    expect(deadlines).toEqual({ statement_timeout: "1s", lock_timeout: "50ms" });
  } finally {
    await client.query("RESET statement_timeout");
    await client.query("RESET lock_timeout");
    client.release();
  }
});

test("audit refusal rolls back acquisition and its complete cursor mutation", async () => {
  await tenantRows(1);
  const before = await state();
  await fixture.db.execute(
    sql`CREATE FUNCTION subkit.reject_sweep_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_sweep_audit_refused'; END $$`,
  );
  await fixture.db.execute(
    sql`CREATE TRIGGER reject_sweep_audit BEFORE INSERT ON subkit.audit_log FOR EACH ROW WHEN (NEW.resource_type = 'scheduler_sweep') EXECUTE FUNCTION subkit.reject_sweep_audit()`,
  );
  try {
    await expect(acquireSweepPage("catalog", firstOwner, fixture.db)).rejects.toMatchObject({
      cause: { message: "fixture_sweep_audit_refused" },
    });
    expect(await state()).toEqual(before);
    expect(await fixture.db.select().from(auditLog)).toEqual([]);
  } finally {
    await fixture.db.execute(sql`DROP TRIGGER reject_sweep_audit ON subkit.audit_log`);
    await fixture.db.execute(sql`DROP FUNCTION subkit.reject_sweep_audit()`);
  }
});

test("counter exhaustion and a missing fixed producer row fail closed", async () => {
  await fixture.db
    .update(schedulerSweepCursors)
    .set({ epoch: Number.MAX_SAFE_INTEGER })
    .where(eq(schedulerSweepCursors.producer, "catalog"));
  await expect(acquireSweepPage("catalog", firstOwner, fixture.db)).rejects.toMatchObject({
    code: "sweep_counter_exhausted",
  });
  await fixture.db
    .delete(schedulerSweepCursors)
    .where(eq(schedulerSweepCursors.producer, "catalog"));
  await expect(acquireSweepPage("catalog", firstOwner, fixture.db)).rejects.toMatchObject({
    code: "sweep_cursor_missing",
  });
});

test("a pre-cutoff transaction that commits late is recovered on the next wrap", async () => {
  const low = "10000000-0000-4000-8000-000000000001";
  const late = "80000000-0000-4000-8000-000000000001";
  const high = "f0000000-0000-4000-8000-000000000001";
  await fixture.db.insert(tenants).values(
    [low, high].map((id) => ({
      id,
      slug: id,
      display_name: "Existing sweep fixture",
      created_at: new Date(FROZEN_NOW - 1000),
    })),
  );
  const inserted = Promise.withResolvers<void>();
  const commit = Promise.withResolvers<void>();
  const writer = fixture.db.transaction(async (tx) => {
    await tx
      .insert(tenants)
      .values({ id: late, slug: late, display_name: "Late committed fixture" });
    inserted.resolve();
    await commit.promise;
  });
  await inserted.promise;
  let page: ReturnType<typeof claimed>;
  try {
    page = claimed(await acquireSweepPage("catalog", firstOwner, fixture.db));
  } finally {
    commit.resolve();
    await writer;
  }
  expect(page.candidates.map((candidate) => candidate.id)).toEqual([low, high]);
  const walked = await walkSweepPage(page, fixture.db, async () => "visited");
  if (walked.kind !== "walked") throw new Error("unexpected lost traversal");
  expect(await completeSweepEpoch(walked.lease, fixture.db)).toEqual({ kind: "completed" });
  const next = claimed(await acquireSweepPage("catalog", firstOwner, fixture.db));
  expect(next.candidates.map((candidate) => candidate.id)).toEqual([low, late, high]);
});

test("renewal and prefix checkpoint audit failures roll back their revision and position", async () => {
  await tenantRows(2);
  const page = claimed(await acquireSweepPage("catalog", firstOwner, fixture.db));
  const before = await state();
  await fixture.db.execute(
    sql`CREATE FUNCTION subkit.reject_progress_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture_progress_audit_refused'; END $$`,
  );
  await fixture.db.execute(
    sql`CREATE TRIGGER reject_progress_audit BEFORE INSERT ON subkit.audit_log FOR EACH ROW WHEN (NEW.action IN ('scheduler.sweep_renewed', 'scheduler.sweep_progressed')) EXECUTE FUNCTION subkit.reject_progress_audit()`,
  );
  try {
    await expect(renewSweepLease(page.lease, fixture.db)).rejects.toMatchObject({
      cause: { message: "fixture_progress_audit_refused" },
    });
    expect(await state()).toEqual(before);
    await expect(walkSweepPage(page, fixture.db, async () => "visited")).rejects.toMatchObject({
      cause: { message: "fixture_progress_audit_refused" },
    });
    expect(await state()).toEqual(before);
  } finally {
    await fixture.db.execute(sql`DROP TRIGGER reject_progress_audit ON subkit.audit_log`);
    await fixture.db.execute(sql`DROP FUNCTION subkit.reject_progress_audit()`);
  }
});

test("the four entity sources return only metadata and exclude inactive parents", async () => {
  const ids = await tenantRows(2);
  const active = ids[0];
  const inactive = ids[1];
  if (!active || !inactive) throw new Error("missing source fixture tenants");
  await fixture.db.update(tenants).set({ status: "suspended" }).where(eq(tenants.id, inactive));
  const large = "fixture-body-must-stay-in-postgres".repeat(32768);
  const born = new Date(FROZEN_NOW - 1000);
  const docs = [uuid(), uuid()];
  await fixture.db.insert(schema.connectors).values(
    [active, inactive].map((tenant_id, index) => ({
      id: docs[index],
      tenant_id,
      slug: `source-docs-${index}`,
      display_name: "Source fixture",
      driver: "http",
      auto_refresh_cron: "0 * * * *",
      config: { large },
      created_at: born,
    })),
  );
  const knowledge = [uuid(), uuid()];
  await fixture.db.insert(schema.knowledgeSources).values(
    [active, inactive].map((tenant_id, index) => ({
      id: knowledge[index],
      tenant_id,
      slug: `source-knowledge-${index}`,
      name: "Knowledge fixture",
      source_type: "url",
      source_uri: "https://example.test/source",
      version: "fixture",
      refresh_strategy: "scheduled" as const,
      refresh_cron: "0 * * * *",
      created_at: born,
    })),
  );
  const workflows = [uuid(), uuid()];
  await fixture.db.insert(schema.workflows).values(
    [active, inactive].map((tenant_id, index) => ({
      id: workflows[index],
      tenant_id,
      slug: `source-workflow-${index}`,
      name: "Workflow fixture",
      lifecycle: "active" as const,
      created_at: born,
    })),
  );
  const schedules = [uuid(), uuid()];
  await fixture.db.insert(schema.workflowsSchedules).values(
    [active, inactive].map((tenant_id, index) => ({
      id: schedules[index],
      tenant_id,
      workflow_id: workflows[index] ?? "",
      cron: "0 * * * *",
      input: { large },
      created_at: born,
    })),
  );
  for (const [producer, expected] of [
    ["docs", docs[0]],
    ["knowledge", knowledge[0]],
    ["workflow-cron", schedules[0]],
  ] as const) {
    if (!expected) throw new Error("missing fixture source ID");
    const page = claimed(await acquireSweepPage(producer, firstOwner, fixture.db));
    expect(page.candidates.map((candidate) => candidate.id)).toEqual([expected]);
    expect(Object.keys(page.candidates[0] ?? {}).sort()).toEqual(["created_at", "id", "tenant_id"]);
    expect(JSON.stringify(page.candidates).includes("fixture-body")).toBe(false);
  }
});
