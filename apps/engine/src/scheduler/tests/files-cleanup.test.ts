import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import {
  auditLog,
  executionSteps,
  executions,
  fileLinks,
  files,
  workflows,
  workflowsSchedules,
} from "../../db/schema/index.ts";
import { runFilesCleanup } from "../../files/scheduled/files-cleanup-runner.ts";
import { attachInlineForTest } from "../../files/test-helpers.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { logRing } from "../../observability/log-ring.ts";
import { EXECUTION_RUN_QUEUE } from "../../queue/queues.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { createFilesCleanupBoss, disposeBoss } from "./pgboss-bootstrap.ts";

const uuid = createDeterministicUuidFactory(0xface02);

let srv: HttpTestServer;
let boss: PgBoss;

beforeAll(async () => {
  srv = await createHttpTestServer("files-cleanup");
  boss = await createFilesCleanupBoss(srv.testDb.url);
}, 60_000);

afterAll(async () => {
  await disposeBoss(boss);
  await srv.cleanup();
}, 30_000);

describe("runFilesCleanup — sweep 1: pending orphans", () => {
  test("pending row with expired upload slot is hard-deleted + audit written", async () => {
    const file_uuid = uuid();
    const expiredAt = new Date(getTestNow() - 2 * 60 * 60 * 1000);
    await srv.db.insert(files).values({
      id: file_uuid,
      tenant_id: srv.tenantId,
      status: "pending",
      filename: "expired-pending.txt",
      storage_uri: `local://${srv.tenantId}/expired/${file_uuid}`,
      size_bytes: 100,
      upload_url_expires_at: expiredAt,
    });

    await runFilesCleanup(new Date(getTestNow()), srv.db, boss, srv.testDb.pool);

    const rows = await srv.db.select().from(files).where(eq(files.id, file_uuid));
    expect(rows).toHaveLength(0);

    const audits = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.action, "file.deleted"),
          eq(auditLog.resource_id, file_uuid),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const meta = audits[0]!.metadata as Record<string, unknown>;
    expect(meta.reason).toBe("pending_expired");
  });

  test("pending row with future upload slot is NOT reaped", async () => {
    const file_uuid = uuid();
    const futureAt = new Date(getTestNow() + 60 * 60 * 1000);
    await srv.db.insert(files).values({
      id: file_uuid,
      tenant_id: srv.tenantId,
      status: "pending",
      filename: "future-pending.txt",
      storage_uri: `local://${srv.tenantId}/future/${file_uuid}`,
      size_bytes: 50,
      upload_url_expires_at: futureAt,
    });

    await runFilesCleanup(new Date(getTestNow()), srv.db, boss, srv.testDb.pool);

    const rows = await srv.db.select().from(files).where(eq(files.id, file_uuid));
    expect(rows).toHaveLength(1);
  });
});

describe("runFilesCleanup — sweep 2: unlinked TTL", () => {
  test("ready unlinked row is soft-deleted by cron", async () => {
    const convId = uuid();
    const att = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id: convId,
      filename: "unlinked.txt",
      content: "unlinked-bytes",
      slug: `unlinked-${uuid().slice(0, 8)}`,
    });

    await srv.db.delete(fileLinks).where(eq(fileLinks.file_id, att.file_uuid));

    await runFilesCleanup(new Date(getTestNow()), srv.db, boss, srv.testDb.pool);

    const [row] = await srv.db.select().from(files).where(eq(files.id, att.file_uuid));
    expect(row).toBeDefined();
    expect(row!.deleted_at).not.toBeNull();
  });

  test("soft-deleted row older than 7d is hard-deleted", async () => {
    const file_uuid = uuid();
    const oldDeletedAt = new Date(getTestNow() - 8 * 24 * 60 * 60 * 1000);
    await srv.db.insert(files).values({
      id: file_uuid,
      tenant_id: srv.tenantId,
      status: "ready",
      filename: "old-soft-del.txt",
      storage_uri: `local://${srv.tenantId}/old/${file_uuid}`,
      size_bytes: 42,
      deleted_at: oldDeletedAt,
    });

    await runFilesCleanup(new Date(getTestNow()), srv.db, boss, srv.testDb.pool);

    const rows = await srv.db.select().from(files).where(eq(files.id, file_uuid));
    expect(rows).toHaveLength(0);

    const audits = await srv.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.tenant_id, srv.tenantId),
          eq(auditLog.action, "file.deleted"),
          eq(auditLog.resource_id, file_uuid),
        ),
      );
    expect(audits.length).toBeGreaterThanOrEqual(1);
    const meta = audits[0]!.metadata as Record<string, unknown>;
    expect(meta.reason).toBe("unlinked_ttl");
  });

  test("in-flight execution referencing a fid blocks unlinked sweep", async () => {
    const convId = uuid();
    const att = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id: convId,
      filename: "inflight.txt",
      content: "inflight-bytes",
      slug: `inflight-${uuid().slice(0, 8)}`,
    });

    await srv.db.delete(fileLinks).where(eq(fileLinks.file_id, att.file_uuid));

    const exec_id = uuid();
    await srv.db.insert(executions).values({
      id: exec_id,
      tenant_id: srv.tenantId,
      source_kind: "draft",
      status: "running",
      source_ref: { steps: [{ input: { doc: { $file: att.file_id } } }] },
      request_source: "api",
      execution_mode: "dev",
    });

    await runFilesCleanup(new Date(getTestNow()), srv.db, boss, srv.testDb.pool);

    const [row] = await srv.db.select().from(files).where(eq(files.id, att.file_uuid));
    expect(row).toBeDefined();
    expect(row!.deleted_at).toBeNull();

    await srv.db.delete(executions).where(eq(executions.id, exec_id));
  });
});

async function seedUnlinked(tenantId = srv.tenantId, deletedAt?: Date) {
  const id = uuid();
  await srv.db.insert(files).values({
    id,
    tenant_id: tenantId,
    status: "ready",
    filename: "guarded.txt",
    storage_uri: `local://${tenantId}/${id}`,
    size_bytes: 1,
    deleted_at: deletedAt,
  });
  return id;
}

async function expectLive(id: string, deletedAt: Date | null = null) {
  const [row] = await srv.db.select().from(files).where(eq(files.id, id));
  expect(row).toBeDefined();
  expect(row?.deleted_at).toEqual(deletedAt);
}

test("public SDK queued, active, retry and scheduled file references guard soft and expired hard candidates", async () => {
  const queued = await seedUnlinked();
  const active = await seedUnlinked();
  const retry = await seedUnlinked();
  const scheduled = await seedUnlinked();
  const expiredAt = new Date(getTestNow() - 8 * 24 * 60 * 60 * 1000);
  const oldActive = await seedUnlinked(srv.tenantId, expiredAt);
  await boss.updateQueue(EXECUTION_RUN_QUEUE, {
    retryLimit: 2,
    retryDelay: 3600,
    retryBackoff: false,
  });
  await boss.send(EXECUTION_RUN_QUEUE, {
    tenant_id: srv.tenantId,
    input: { $file: active, older: { $file: oldActive } },
  });
  const retryJob = await boss.send(EXECUTION_RUN_QUEUE, {
    tenant_id: srv.tenantId,
    input: { $file: retry },
  });
  await boss.fetch(EXECUTION_RUN_QUEUE, { batchSize: 2 });
  if (!retryJob) throw new Error("missing retry job fixture");
  await boss.fail(EXECUTION_RUN_QUEUE, retryJob);
  await boss.send(EXECUTION_RUN_QUEUE, { tenant_id: srv.tenantId, input: { $file: queued } });
  await boss.schedule(
    EXECUTION_RUN_QUEUE,
    "0 0 1 1 *",
    { tenant_id: srv.tenantId, input: { $file: scheduled } },
    { key: "file-guard" },
  );
  await runFilesCleanup(new Date(getTestNow()), srv.db, boss, srv.testDb.pool);
  for (const id of [queued, active, retry, scheduled]) await expectLive(id);
  await expectLive(oldActive, expiredAt);
  await boss.deleteAllJobs(EXECUTION_RUN_QUEUE);
  await boss.unschedule(EXECUTION_RUN_QUEUE, "file-guard");
});

test("persisted queued input and workflow schedule input guard files without queue payload copies", async () => {
  const queued = await seedUnlinked();
  const scheduled = await seedUnlinked();
  const executionId = uuid();
  await srv.db.insert(executions).values({
    id: executionId,
    tenant_id: srv.tenantId,
    status: "queued",
    source_kind: "draft",
    input: { $file: queued },
    request_source: "api",
    execution_mode: "dev",
  });
  const [workflow] = await srv.db
    .insert(workflows)
    .values({
      tenant_id: srv.tenantId,
      slug: "file-scheduled",
      name: "File scheduled",
      lifecycle: "active",
    })
    .returning();
  if (!workflow) throw new Error("missing scheduled workflow fixture");
  await srv.db.insert(workflowsSchedules).values({
    tenant_id: srv.tenantId,
    workflow_id: workflow.id,
    cron: "0 0 1 1 *",
    input: { $file: scheduled },
  });
  await runFilesCleanup(new Date(getTestNow()), srv.db, boss, srv.testDb.pool);
  await expectLive(queued);
  await expectLive(scheduled);
  await srv.db.delete(executions).where(eq(executions.id, executionId));
  await srv.db.delete(workflows).where(eq(workflows.id, workflow.id));
});

test("neighbor-tenant SDK references and mismatched product parent rows do not guard another tenant", async () => {
  const id = await seedUnlinked();
  const foreign = await seedTenant(srv.db, { slug: "cleanup-foreign", display_name: "Foreign" });
  const executionId = uuid();
  await srv.db.insert(executions).values({
    id: executionId,
    tenant_id: foreign.id,
    status: "running",
    source_kind: "draft",
    input: { $file: id },
    request_source: "api",
    execution_mode: "dev",
  });
  await srv.db.insert(executionSteps).values({
    tenant_id: srv.tenantId,
    execution_id: executionId,
    step_key: "foreign-parent",
    kind: "code",
    status: "running",
    input_preview: { $file: id },
  });
  const [foreignWorkflow] = await srv.db
    .insert(workflows)
    .values({ tenant_id: foreign.id, slug: "file-foreign", name: "Foreign", lifecycle: "active" })
    .returning();
  if (!foreignWorkflow) throw new Error("missing foreign workflow fixture");
  await srv.db.insert(workflowsSchedules).values({
    tenant_id: srv.tenantId,
    workflow_id: foreignWorkflow.id,
    cron: "0 0 1 1 *",
    input: { $file: id },
  });
  await boss.send(EXECUTION_RUN_QUEUE, { tenant_id: foreign.id, input: { $file: id } });
  await runFilesCleanup(new Date(getTestNow()), srv.db, boss, srv.testDb.pool);
  const [row] = await srv.db.select().from(files).where(eq(files.id, id));
  expect(row?.deleted_at).not.toBeNull();
  await boss.deleteAllJobs(EXECUTION_RUN_QUEUE);
});

test("an incomplete SDK scan preserves both soft and expired hard candidates", async () => {
  const soft = await seedUnlinked();
  const expiredAt = new Date(getTestNow() - 8 * 24 * 60 * 60 * 1000);
  const hard = await seedUnlinked(srv.tenantId, expiredAt);
  const unknown = new PgBoss({
    db: boss.getDb(),
    migrate: false,
    supervise: false,
    schedule: false,
  });
  await runFilesCleanup(new Date(getTestNow()), srv.db, unknown, srv.testDb.pool);
  await expectLive(soft);
  await expectLive(hard, expiredAt);
});

test("oversized product input fails closed before projecting its body into cleanup inventory", async () => {
  const fileId = await seedUnlinked();
  const executionId = uuid();
  await srv.db.insert(executions).values({
    id: executionId,
    tenant_id: srv.tenantId,
    status: "queued",
    source_kind: "draft",
    input: { body: "cleanup-product-canary".repeat(10000) },
    request_source: "api",
    execution_mode: "dev",
  });
  await runFilesCleanup(new Date(getTestNow()), srv.db, boss, srv.testDb.pool, {
    rows: 100,
    bytes: 4096,
    deadline_ms: 5000,
  });
  await expectLive(fileId);
  expect(JSON.stringify(logRing.tail({ limit: 1000 }))).not.toContain("cleanup-product-canary");
  await srv.db.delete(executions).where(eq(executions.id, executionId));
});

test("product inventory row cap never treats a partial reference scan as absence", async () => {
  const fileId = await seedUnlinked();
  const executionIds = [uuid(), uuid(), uuid()];
  for (const id of executionIds)
    await srv.db.insert(executions).values({
      id,
      tenant_id: srv.tenantId,
      status: "queued",
      source_kind: "draft",
      input: { unrelated: true },
      request_source: "api",
      execution_mode: "dev",
    });
  await runFilesCleanup(new Date(getTestNow()), srv.db, boss, srv.testDb.pool, {
    rows: 2,
    bytes: 1024 * 1024,
    deadline_ms: 5000,
  });
  await expectLive(fileId);
  for (const id of executionIds) await srv.db.delete(executions).where(eq(executions.id, id));
});
