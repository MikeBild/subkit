import { afterAll, beforeAll, expect, test } from "bun:test";
import pg from "pg";
import { PgBoss } from "pg-boss";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createBossReadOnlyReader } from "../../queue/boss.ts";
import { findAllJobs, listAllQueues, listAllSchedules } from "../../queue/list-all.ts";
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

async function seedPendingThenFiveCompletedThenPendingThenFourCompletedThenActive() {
  const deferred = { startAfter: 3600 };
  const completeNext = async (count: number) => {
    for (let i = 0; i < count; i++) await boss.send(EXECUTION_RUN_QUEUE, { history: i });
    const jobs = await boss.fetch(EXECUTION_RUN_QUEUE, { batchSize: count });
    expect(jobs).toHaveLength(count);
    await boss.complete(
      EXECUTION_RUN_QUEUE,
      jobs.map((job) => job.id),
    );
  };
  await boss.send(EXECUTION_RUN_QUEUE, { marker: "pending-first" }, deferred);
  await completeNext(5);
  await boss.send(EXECUTION_RUN_QUEUE, { marker: "pending-middle" }, deferred);
  await completeNext(4);
  await boss.send(EXECUTION_RUN_QUEUE, { marker: "active-last" });
  expect(await boss.fetch(EXECUTION_RUN_QUEUE)).toHaveLength(1);
}

const pendingMarkers = (payloads: Array<{ payload: string }>) =>
  payloads.map((part) => (JSON.parse(part.payload) as { marker?: string }).marker);

test("pending jobs behind pages of completed history are read and only they count against the budget", async () => {
  await seedPendingThenFiveCompletedThenPendingThenFourCompletedThenActive();
  for (const key of ["one", "two", "three"])
    await boss.schedule(EXECUTION_RUN_QUEUE, "0 0 1 1 *", { marker: key }, { key });
  const payloads = await loadCleanupQueuePayloads(
    boss,
    ctx.pool,
    { ...budget, rows: 7 },
    undefined,
    2,
  );
  expect(pendingMarkers(payloads)).toEqual([
    "pending-first",
    "pending-middle",
    "active-last",
    "one",
    "three",
    "two",
  ]);
  await expect(
    loadCleanupQueuePayloads(boss, ctx.pool, { ...budget, rows: 6 }, undefined, 2),
  ).rejects.toThrow("budget_exceeded");
  for (const key of ["one", "two", "three"]) await boss.unschedule(EXECUTION_RUN_QUEUE, key);
  await boss.deleteAllJobs(EXECUTION_RUN_QUEUE);
});

test("a cursor job deleted between two pages restarts the scan with its budget instead of truncating", async () => {
  await seedPendingThenFiveCompletedThenPendingThenFourCompletedThenActive();
  const deletedCursors: unknown[] = [];
  const pool = new Proxy(ctx.pool, {
    get(target, property) {
      if (property !== "connect") return Reflect.get(target, property, target);
      return async () => {
        const client = await target.connect();
        return new Proxy(client, {
          get(inner, key) {
            const value = Reflect.get(inner, key, inner);
            if (key !== "query") return typeof value === "function" ? value.bind(inner) : value;
            return async (text: string, values?: unknown[]) => {
              const isCursorJobLookup =
                text.startsWith("DECLARE") && !text.includes("LIMIT") && values?.length === 2;
              if (deletedCursors.length === 0 && isCursorJobLookup) {
                deletedCursors.push(values[1]);
                await boss.deleteJob(EXECUTION_RUN_QUEUE, String(values[1]));
              }
              return inner.query(text, values);
            };
          },
        });
      };
    },
  });
  const payloads = await loadCleanupQueuePayloads(boss, pool, { ...budget, rows: 4 }, undefined, 2);
  expect(deletedCursors).toHaveLength(1);
  expect(pendingMarkers(payloads)).toEqual(["pending-first", "pending-middle", "active-last"]);
  await boss.deleteAllJobs(EXECUTION_RUN_QUEUE);
});

test("paged lists return the same rows as one unbounded read of the queue", async () => {
  await seedPendingThenFiveCompletedThenPendingThenFourCompletedThenActive();
  for (const key of ["one", "two", "three"])
    await boss.schedule(EXECUTION_RUN_QUEUE, "0 0 1 1 *", { marker: key }, { key });
  const ids = (jobs: Array<{ id: string }>) => jobs.map((job) => job.id);
  const all = await boss.findJobs(EXECUTION_RUN_QUEUE);
  expect(all).toHaveLength(12);
  expect(ids(await findAllJobs(boss, EXECUTION_RUN_QUEUE, {}, 5))).toEqual(ids(all));
  expect(ids(await findAllJobs(boss, EXECUTION_RUN_QUEUE, { queued: true }, 1))).toEqual(
    ids(all.filter((job) => job.state === "created")),
  );
  const queues = await boss.getQueues();
  expect(queues.length).toBeGreaterThan(3);
  expect((await listAllQueues(boss, 3)).map((queue) => queue.name)).toEqual(
    queues.map((queue) => queue.name),
  );
  expect((await listAllSchedules(boss, 2)).map((schedule) => schedule.key)).toEqual([
    "one",
    "three",
    "two",
  ]);
  const middle = all[5];
  if (!middle) throw new Error("missing job fixture");
  await boss.deleteJob(EXECUTION_RUN_QUEUE, middle.id);
  await expect(boss.findJobs(EXECUTION_RUN_QUEUE, { limit: 5, after: middle.id })).rejects.toThrow(
    "after names a row that no longer exists",
  );
  for (const key of ["one", "two", "three"]) await boss.unschedule(EXECUTION_RUN_QUEUE, key);
  await boss.deleteAllJobs(EXECUTION_RUN_QUEUE);
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
