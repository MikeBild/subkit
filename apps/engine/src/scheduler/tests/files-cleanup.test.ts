import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, executions, fileLinks, files } from "../../db/schema/index.ts";
import { attachInlineForTest } from "../../files/test-helpers.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { runFilesCleanup } from "../files-cleanup-runner.ts";
import { bootstrapMinimalPgbossSchema } from "./pgboss-bootstrap.ts";

const uuid = createDeterministicUuidFactory(0xface02);

let srv: HttpTestServer;

beforeAll(async () => {
  srv = await createHttpTestServer("files-cleanup");
  await bootstrapMinimalPgbossSchema(srv.db);
}, 60_000);

afterAll(async () => {
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

    await runFilesCleanup(new Date(getTestNow()), srv.db);

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

    await runFilesCleanup(new Date(getTestNow()), srv.db);

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

    await runFilesCleanup(new Date(getTestNow()), srv.db);

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

    await runFilesCleanup(new Date(getTestNow()), srv.db);

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

    await runFilesCleanup(new Date(getTestNow()), srv.db);

    const [row] = await srv.db.select().from(files).where(eq(files.id, att.file_uuid));
    expect(row).toBeDefined();
    expect(row!.deleted_at).toBeNull();

    await srv.db.delete(executions).where(eq(executions.id, exec_id));
  });
});
