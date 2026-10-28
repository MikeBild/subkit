import { afterAll, beforeAll, expect, test } from "bun:test";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createBossReadOnlyReader } from "../../queue/boss.ts";
import { EXECUTION_RUN_QUEUE } from "../../queue/queues.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { loadCleanupQueuePayloads } from "../cleanup-queue-reader.ts";
import { createFilesCleanupBoss, disposeBoss } from "./pgboss-bootstrap.ts";

let ctx: TestDb;
let boss: PgBoss;
let neighbor: PgBoss;

beforeAll(async () => {
  ctx = await createTestDb("cleanup-queue-api");
  boss = await createFilesCleanupBoss(ctx.url);
  neighbor = await createFilesCleanupBoss(ctx.url, "files_cleanup_neighbor");
});

afterAll(async () => {
  await disposeBoss(neighbor);
  await disposeBoss(boss);
  await ctx.cleanup();
});

const budget = { rows: 100, bytes: 1024 * 1024, deadline_ms: 5000 };

test("unstarted public reader lists owned schedules without starting any maintenance", async () => {
  await boss.schedule(
    EXECUTION_RUN_QUEUE,
    "0 0 1 1 *",
    { marker: "owned-schedule" },
    { key: "owned" },
  );
  await neighbor.schedule(
    EXECUTION_RUN_QUEUE,
    "0 0 1 1 *",
    { marker: "neighbor-schedule" },
    { key: "neighbor" },
  );
  const reader = createBossReadOnlyReader(boss, boss.getDb());
  expect(reader.isMaintaining()).toBe(false);
  expect(reader.isTimekeeping()).toBe(false);
  expect(reader.isBamWorking()).toBe(false);
  expect(reader.getWipData()).toEqual([]);
  const schedules = await reader.getSchedules();
  expect(schedules).toHaveLength(1);
  expect(schedules[0]?.data).toMatchObject({ marker: "owned-schedule" });
  expect(await boss.getSchedules()).toHaveLength(1);
  expect(await neighbor.getSchedules()).toHaveLength(1);
  await boss.unschedule(EXECUTION_RUN_QUEUE, "owned");
  await neighbor.unschedule(EXECUTION_RUN_QUEUE, "neighbor");
});

test("bounded SDK scan preserves queued, active, retry and schedules without reading neighbor namespace", async () => {
  await boss.updateQueue(EXECUTION_RUN_QUEUE, {
    retryLimit: 2,
    retryDelay: 3600,
    retryBackoff: false,
  });
  const active = await boss.send(EXECUTION_RUN_QUEUE, { marker: "active" });
  const retry = await boss.send(EXECUTION_RUN_QUEUE, { marker: "retry" });
  const fetched = await boss.fetch(EXECUTION_RUN_QUEUE, { batchSize: 2, includeMetadata: true });
  expect(fetched).toHaveLength(2);
  if (!active || !retry) throw new Error("missing job fixture");
  await boss.fail(EXECUTION_RUN_QUEUE, retry);
  await boss.send(EXECUTION_RUN_QUEUE, { marker: "queued" });
  await boss.schedule(
    EXECUTION_RUN_QUEUE,
    "0 0 1 1 *",
    { marker: "schedule" },
    { key: "inflight" },
  );
  await neighbor.send(EXECUTION_RUN_QUEUE, { marker: "neighbor" });
  const payloads = await loadCleanupQueuePayloads(boss, ctx.pool, budget);
  const serialized = JSON.stringify(payloads);
  for (const marker of ["active", "retry", "queued", "schedule"])
    expect(serialized).toContain(marker);
  expect(serialized).not.toContain('"neighbor"');
  expect((await boss.findJobs(EXECUTION_RUN_QUEUE, { id: active }))[0]?.state).toBe("active");
  expect((await boss.findJobs(EXECUTION_RUN_QUEUE, { id: retry }))[0]?.state).toBe("retry");
  await boss.deleteAllJobs(EXECUTION_RUN_QUEUE);
  await neighbor.deleteAllJobs(EXECUTION_RUN_QUEUE);
  await boss.unschedule(EXECUTION_RUN_QUEUE, "inflight");
});

test("retained completed history stays outside the row budget while pending jobs and schedules never return partial scans", async () => {
  for (let i = 0; i < 3; i++) await boss.send(EXECUTION_RUN_QUEUE, { history: i });
  const jobs = await boss.fetch(EXECUTION_RUN_QUEUE, { batchSize: 3 });
  await boss.complete(
    EXECUTION_RUN_QUEUE,
    jobs.map((job) => job.id),
  );
  expect(await loadCleanupQueuePayloads(boss, ctx.pool, { ...budget, rows: 2 })).toEqual([]);
  for (let i = 0; i < 3; i++) await boss.send(EXECUTION_RUN_QUEUE, { pending: i });
  await expect(loadCleanupQueuePayloads(boss, ctx.pool, { ...budget, rows: 2 })).rejects.toThrow(
    "budget_exceeded",
  );
  await boss.deleteAllJobs(EXECUTION_RUN_QUEUE);
  for (const key of ["one", "two", "three"])
    await boss.schedule(EXECUTION_RUN_QUEUE, "0 0 1 1 *", { key }, { key });
  await expect(loadCleanupQueuePayloads(boss, ctx.pool, { ...budget, rows: 2 })).rejects.toThrow(
    "budget_exceeded",
  );
  for (const key of ["one", "two", "three"]) await boss.unschedule(EXECUTION_RUN_QUEUE, key);
});

test("byte/deadline errors and unknown SDK owner fail closed and release database sessions", async () => {
  await boss.send(EXECUTION_RUN_QUEUE, { large: "x".repeat(1000) });
  await expect(loadCleanupQueuePayloads(boss, ctx.pool, { ...budget, bytes: 100 })).rejects.toThrow(
    "budget_exceeded",
  );
  await expect(
    loadCleanupQueuePayloads(boss, ctx.pool, { ...budget, deadline_ms: 0 }),
  ).rejects.toThrow("deadline_exceeded");
  const unknown = new PgBoss({
    db: boss.getDb(),
    migrate: false,
    supervise: false,
    schedule: false,
  });
  await expect(loadCleanupQueuePayloads(unknown, ctx.pool, budget)).rejects.toThrow(
    "owner_unknown",
  );
  expect(ctx.pool.waitingCount).toBe(0);
  await boss.deleteAllJobs(EXECUTION_RUN_QUEUE);
  expect(await loadCleanupQueuePayloads(boss, ctx.pool, budget)).toEqual([]);
});

test("pool acquisition deadline releases its eventual connection instead of leaking a session", async () => {
  const pool = new pg.Pool({ connectionString: ctx.url, max: 1 });
  const held = await pool.connect();
  try {
    await expect(
      loadCleanupQueuePayloads(boss, pool, { ...budget, deadline_ms: 20 }),
    ).rejects.toThrow("deadline_exceeded");
  } finally {
    held.release();
    await waitFor(() => pool.waitingCount === 0 && pool.idleCount === 1, {
      label: "expired queue reader returns pool connection",
      sleepMs: 5,
    });
    await pool.end();
  }
});
