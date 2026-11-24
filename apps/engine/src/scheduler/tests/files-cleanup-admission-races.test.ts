import { expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import pg from "pg";
import { executions, files, workflows } from "../../db/schema/index.ts";
import { createExecution } from "../../execution/state.ts";
import { runFilesCleanup } from "../../files/scheduled/files-cleanup-runner.ts";
import { createHttpTestServer } from "../../http/tests/setup.ts";
import { getMetrics, METRIC_NAMES } from "../../observability/metrics.ts";
import { EXECUTION_RUN_QUEUE } from "../../queue/queues.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { waitFor } from "../../test-helpers/determinism/wait.ts";
import { createSchedule, updateSchedule } from "../repo.ts";
import { createFilesCleanupBoss, disposeBoss } from "./pgboss-bootstrap.ts";

const uuid = createDeterministicUuidFactory(0xc1ea9);

for (const hosted of [false, true]) {
  test(`new admission after reference snapshot guards soft and hard candidates (${hosted ? "hosted" : "self-hosted"})`, async () => {
    const srv = await createHttpTestServer(`cleanup-admission-${hosted ? "hosted" : "self"}`, {
      hosted,
    });
    const boss = await createFilesCleanupBoss(srv.testDb.url);
    const readerPool = new pg.Pool({ connectionString: srv.testDb.url, max: 1 });
    const blocker = await srv.testDb.pool.connect();
    const lockKey = 741993;
    let leases = 0;
    let blockedPid: number | undefined;
    readerPool.on("acquire", (client) => {
      leases++;
      if (leases === 6) {
        void client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid").then((result) => {
          blockedPid = result.rows[0]?.pid;
        });
        void client.query("SELECT pg_advisory_xact_lock($1)", [lockKey]).catch(() => {});
      }
    });
    try {
      const soft = uuid();
      const hard = uuid();
      const expired = new Date(getTestNow() - 8 * 24 * 60 * 60 * 1000);
      await srv.db.insert(files).values([
        {
          id: soft,
          tenant_id: srv.tenantId,
          status: "ready",
          filename: "soft.txt",
          storage_uri: `local://${srv.tenantId}/${soft}`,
          size_bytes: 1,
        },
        {
          id: hard,
          tenant_id: srv.tenantId,
          status: "ready",
          filename: "hard.txt",
          storage_uri: `local://${srv.tenantId}/${hard}`,
          size_bytes: 1,
          deleted_at: expired,
        },
      ]);
      await blocker.query("SELECT pg_advisory_lock($1)", [lockKey]);
      const cleanup = runFilesCleanup(new Date(getTestNow()), srv.db, boss, readerPool);
      await waitFor(
        async () => {
          if (!blockedPid) return false;
          const result = await srv.testDb.pool.query<{ blocked: boolean }>(
            "SELECT cardinality(pg_blocking_pids($1))>0 AS blocked",
            [blockedPid],
          );
          return result.rows[0]?.blocked;
        },
        { label: "cleanup pauses after product reference snapshot", sleepMs: 5 },
      );
      const executionId = await createExecution(srv.db, {
        tenant_id: srv.tenantId,
        workflow_id: null,
        workflow_version_id: null,
        source_kind: "draft",
        source_ref: null,
        request_source: "api",
        execution_mode: "dev",
        input: { $file: soft, older: { $file: hard } },
      });
      await blocker.query("SELECT pg_advisory_unlock($1)", [lockKey]);
      await cleanup;
      const [softRow] = await srv.db.select().from(files).where(eq(files.id, soft));
      const [hardRow] = await srv.db.select().from(files).where(eq(files.id, hard));
      expect(softRow?.deleted_at).toBeNull();
      expect(hardRow?.deleted_at).toEqual(expired);
      expect(
        await srv.db.select().from(executions).where(eq(executions.id, executionId)),
      ).toHaveLength(1);
    } finally {
      await blocker.query("SELECT pg_advisory_unlock_all()");
      blocker.release();
      await readerPool.end();
      await disposeBoss(boss);
      await srv.cleanup();
    }
  });
}

test("admission and schedule producers use the cleanup catalog lock before writing", async () => {
  const srv = await createHttpTestServer("cleanup-producer-locks");
  const blocker = await srv.testDb.pool.connect();
  try {
    const [workflow] = await srv.db
      .insert(workflows)
      .values({
        tenant_id: srv.tenantId,
        slug: "schedule-lock",
        name: "Schedule",
        lifecycle: "active",
      })
      .returning();
    if (!workflow) throw new Error("missing workflow fixture");
    const schedule = await createSchedule(srv.db, {
      creator: null,
      tenant_id: srv.tenantId,
      workflow_id: workflow.id,
      cron: "0 0 1 1 *",
    });
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,741937))", [
      srv.tenantId,
    ]);
    await expect(
      createExecution(srv.db, {
        tenant_id: srv.tenantId,
        workflow_id: null,
        workflow_version_id: null,
        source_kind: "draft",
        source_ref: null,
        request_source: "api",
        input: null,
      }),
    ).rejects.toMatchObject({ code: "40001" });
    await expect(
      createSchedule(srv.db, {
        creator: null,
        tenant_id: srv.tenantId,
        workflow_id: workflow.id,
        cron: "0 1 1 1 *",
      }),
    ).rejects.toMatchObject({ code: "40001" });
    await expect(
      updateSchedule(srv.db, srv.tenantId, schedule.row.id, { input: { $file: uuid() } }),
    ).rejects.toMatchObject({ code: "40001" });
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await srv.cleanup();
  }
});

test("unlinked cleanup retries a catalog conflict with a fresh reference scan", async () => {
  const srv = await createHttpTestServer("cleanup-catalog-retry");
  const boss = await createFilesCleanupBoss(srv.testDb.url);
  const blocker = await srv.testDb.pool.connect();
  try {
    const id = uuid();
    await srv.db.insert(files).values({
      id,
      tenant_id: srv.tenantId,
      status: "ready",
      filename: "retry.txt",
      storage_uri: `local://${srv.tenantId}/${id}`,
      size_bytes: 1,
      created_at: sql`now() - interval '2 days'`,
    });
    await blocker.query("BEGIN");
    await blocker.query("SELECT pg_advisory_xact_lock(hashtextextended($1::text,741937))", [
      srv.tenantId,
    ]);
    const retries = () =>
      getMetrics()
        .snapshot()
        .find((metric) => metric.name === METRIC_NAMES.DB_TRANSIENT_RETRIES_TOTAL)
        ?.samples.find((sample) => sample.labels.label === "files_cleanup_unlinked")?.value ?? 0;
    const before = retries();
    const cleanup = runFilesCleanup(new Date(getTestNow()), srv.db, boss, srv.testDb.pool);
    await waitFor(() => retries() > before, {
      label: "cleanup retried catalog lock",
      sleepMs: 5,
      tries: 1000,
    });
    await boss.send(EXECUTION_RUN_QUEUE, { tenant_id: srv.tenantId, input: { $file: id } });
    await blocker.query("ROLLBACK");
    await cleanup;
    const [protectedFile] = await srv.db.select().from(files).where(eq(files.id, id));
    expect(protectedFile?.deleted_at).toBeNull();
    await boss.deleteAllJobs(EXECUTION_RUN_QUEUE);
    await runFilesCleanup(new Date(getTestNow()), srv.db, boss, srv.testDb.pool);
    const [unlinkedFile] = await srv.db.select().from(files).where(eq(files.id, id));
    expect(unlinkedFile?.deleted_at).not.toBeNull();
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await disposeBoss(boss);
    await srv.cleanup();
  }
});

test("encrypted queued input conservatively protects tenant files without decryption", async () => {
  const srv = await createHttpTestServer("cleanup-sensitive");
  const boss = await createFilesCleanupBoss(srv.testDb.url);
  try {
    const id = uuid();
    await srv.db.insert(files).values({
      id,
      tenant_id: srv.tenantId,
      status: "ready",
      filename: "sensitive.txt",
      storage_uri: `local://${srv.tenantId}/${id}`,
      size_bytes: 1,
    });
    const executionId = await createExecution(srv.db, {
      tenant_id: srv.tenantId,
      workflow_id: null,
      workflow_version_id: null,
      source_kind: "draft",
      source_ref: null,
      request_source: "api",
      execution_privacy: "sensitive",
      input: { $file: id },
    });
    const [execution] = await srv.db
      .select()
      .from(executions)
      .where(eq(executions.id, executionId));
    expect(execution?.input).toMatchObject({ $sensitive: true });
    expect(JSON.stringify(execution?.input)).not.toContain(id);
    await runFilesCleanup(new Date(getTestNow()), srv.db, boss, srv.testDb.pool);
    const [file] = await srv.db.select().from(files).where(eq(files.id, id));
    expect(file?.deleted_at).toBeNull();
  } finally {
    await disposeBoss(boss);
    await srv.cleanup();
  }
});
