// Integration tests for the files cleanup cron handler.
//
// Three sweeps in one handler invocation:
//   1. Pending+expired rows are hard-deleted + object removed.
//   2. Ready+unlinked rows are soft-deleted; soft-deleted >7d are hard-deleted.
//   3. LLM-expired rows have provider ids nulled out.
//
// In-flight workflow run referencing a fid blocks the unlinked sweep.
// Real Postgres via createHttpTestServer (config loaded).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { auditLog, executions, fileLinks, files } from "../../db/schema/index.ts";
import { attachInlineForTest } from "../../files/test-helpers.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { runFilesCleanup } from "../files-cleanup-runner.ts";

let srv: HttpTestServer;

beforeAll(async () => {
  srv = await createHttpTestServer("files-cleanup");
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 30_000);

describe("runFilesCleanup — sweep 1: pending orphans", () => {
  test("pending row with expired presign URL is hard-deleted + audit written", async () => {
    const file_uuid = randomUUID();
    // 2 hours ago — well past the 1-hour PENDING_EXPIRY_GRACE
    const expiredAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await srv.db.insert(files).values({
      id: file_uuid,
      tenant_id: srv.tenantId,
      status: "pending",
      filename: "expired-pending.txt",
      storage_uri: `local://${srv.tenantId}/expired/${file_uuid}`,
      size_bytes: 100,
      upload_url_expires_at: expiredAt,
    });

    await runFilesCleanup(new Date(), srv.db);

    // Row should be gone
    const rows = await srv.db.select().from(files).where(eq(files.id, file_uuid));
    expect(rows).toHaveLength(0);

    // FILE_DELETED audit row with reason=pending_expired
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

  test("pending row with future presign URL is NOT reaped", async () => {
    const file_uuid = randomUUID();
    const futureAt = new Date(Date.now() + 60 * 60 * 1000);
    await srv.db.insert(files).values({
      id: file_uuid,
      tenant_id: srv.tenantId,
      status: "pending",
      filename: "future-pending.txt",
      storage_uri: `local://${srv.tenantId}/future/${file_uuid}`,
      size_bytes: 50,
      upload_url_expires_at: futureAt,
    });

    await runFilesCleanup(new Date(), srv.db);

    const rows = await srv.db.select().from(files).where(eq(files.id, file_uuid));
    expect(rows).toHaveLength(1);
  });
});

describe("runFilesCleanup — sweep 2: unlinked TTL", () => {
  test("ready unlinked row is soft-deleted by cron", async () => {
    const convId = randomUUID();
    const att = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id: convId,
      filename: "unlinked.txt",
      content: "unlinked-bytes",
      slug: `unlinked-${randomUUID().slice(0, 8)}`,
    });

    // Remove the link so it's orphaned
    await srv.db.delete(fileLinks).where(eq(fileLinks.file_id, att.file_uuid));

    await runFilesCleanup(new Date(), srv.db);

    const [row] = await srv.db.select().from(files).where(eq(files.id, att.file_uuid));
    expect(row).toBeDefined();
    // Soft-deleted
    expect(row!.deleted_at).not.toBeNull();
  });

  test("soft-deleted row older than 7d is hard-deleted", async () => {
    const file_uuid = randomUUID();
    const oldDeletedAt = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await srv.db.insert(files).values({
      id: file_uuid,
      tenant_id: srv.tenantId,
      status: "ready",
      filename: "old-soft-del.txt",
      storage_uri: `local://${srv.tenantId}/old/${file_uuid}`,
      size_bytes: 42,
      deleted_at: oldDeletedAt,
    });

    await runFilesCleanup(new Date(), srv.db);

    const rows = await srv.db.select().from(files).where(eq(files.id, file_uuid));
    expect(rows).toHaveLength(0);

    // FILE_DELETED audit with reason=unlinked_ttl
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
    const convId = randomUUID();
    const att = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id: convId,
      filename: "inflight.txt",
      content: "inflight-bytes",
      slug: `inflight-${randomUUID().slice(0, 8)}`,
    });

    // Remove link to make it "orphaned"
    await srv.db.delete(fileLinks).where(eq(fileLinks.file_id, att.file_uuid));

    // Insert a running execution (draft, no FK to workflow) referencing the fid
    const exec_id = randomUUID();
    await srv.db.insert(executions).values({
      id: exec_id,
      tenant_id: srv.tenantId,
      source_kind: "draft",
      status: "running",
      source_ref: { steps: [{ input: { doc: { $file: att.file_id } } }] },
      request_source: "api",
      execution_mode: "dev",
    });

    await runFilesCleanup(new Date(), srv.db);

    // File must still be present (not soft-deleted)
    const [row] = await srv.db.select().from(files).where(eq(files.id, att.file_uuid));
    expect(row).toBeDefined();
    expect(row!.deleted_at).toBeNull();

    // Clean up
    await srv.db.delete(executions).where(eq(executions.id, exec_id));
  });
});

describe("runFilesCleanup — sweep 3: LLM provider expiry", () => {
  test("expired provider ids are nulled out, row stays ready", async () => {
    const convId = randomUUID();
    const att = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id: convId,
      filename: "llm-exp.txt",
      content: "llm-expiry-test",
      slug: `llm-exp-${randomUUID().slice(0, 8)}`,
    });

    const pastExpiry = new Date(Date.now() - 60 * 1000);
    await srv.db
      .update(files)
      .set({
        anthropic_file_id: "file_anthropic_abc123",
        openai_file_id: "file-openai-xyz",
        llm_file_expires_at: pastExpiry,
      })
      .where(eq(files.id, att.file_uuid));

    await runFilesCleanup(new Date(), srv.db);

    const [row] = await srv.db.select().from(files).where(eq(files.id, att.file_uuid));
    expect(row).toBeDefined();
    expect(row!.anthropic_file_id).toBeNull();
    expect(row!.openai_file_id).toBeNull();
    expect(row!.llm_file_expires_at).toBeNull();
    expect(row!.status).toBe("ready");
    expect(row!.deleted_at).toBeNull();
  });

  test("non-expired provider ids are not touched", async () => {
    const convId = randomUUID();
    const att = await attachInlineForTest({
      db: srv.db,
      tenant_id: srv.tenantId,
      conversation_id: convId,
      filename: "llm-valid.txt",
      content: "llm-valid-test",
      slug: `llm-valid-${randomUUID().slice(0, 8)}`,
    });

    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await srv.db
      .update(files)
      .set({ anthropic_file_id: "file_valid_abc", llm_file_expires_at: futureExpiry })
      .where(eq(files.id, att.file_uuid));

    await runFilesCleanup(new Date(), srv.db);

    const [row] = await srv.db.select().from(files).where(eq(files.id, att.file_uuid));
    expect(row!.anthropic_file_id).toBe("file_valid_abc");
    expect(row!.llm_file_expires_at).not.toBeNull();
  });
});
