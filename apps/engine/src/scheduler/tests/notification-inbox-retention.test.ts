// Integration tests for the cli_notification_inbox retention sweep.
//
// `ack` marks read instead of deleting, so this sweep is the only path
// that removes an inbox row. Asserts:
//   - rows older than notifications.inbox.retention_days are deleted
//   - newer rows survive
//   - per-user read marks cascade away with their row
//   - one summary NOTIFICATION_INBOX_PRUNED audit row per sweep
//   - a second sweep over the same data is a no-op, not an error

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { auditLog } from "../../db/schema/audit.ts";
import { cliNotificationInbox, cliNotificationInboxReads } from "../../db/schema/notifications.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import { runNotificationInboxRetention } from "../notification-inbox-retention-runner.ts";

let srv: HttpTestServer;

const DAY_MS = 24 * 60 * 60 * 1000;
// The sweep reads `now` from its argument, so the fixed clock below is
// the only time source the assertions depend on.
const NOW = new Date("2026-03-01T12:00:00.000Z");
const RETENTION_DAYS = 30;

async function insertRow(createdAt: Date, eventType: string): Promise<number> {
  const [row] = await srv.db
    .insert(cliNotificationInbox)
    .values({
      tenant_id: srv.tenantId,
      severity: "info",
      event_type: eventType,
      event_payload: { test: true },
      created_at: createdAt,
    })
    .returning({ id: cliNotificationInbox.id });
  if (!row) throw new Error("inbox row insert failed");
  return row.id;
}

async function inboxIds(): Promise<number[]> {
  const rows = await srv.db
    .select({ id: cliNotificationInbox.id })
    .from(cliNotificationInbox)
    .where(eq(cliNotificationInbox.tenant_id, srv.tenantId));
  return rows.map((r) => r.id);
}

async function pruneAuditRows() {
  return srv.db.select().from(auditLog).where(eq(auditLog.action, "notification.inbox_pruned"));
}

beforeAll(async () => {
  srv = await createHttpTestServer("notification-inbox-retention");
}, 60_000);

afterAll(async () => {
  await srv.cleanup();
}, 30_000);

async function wipe(): Promise<void> {
  await srv.db.delete(cliNotificationInbox);
  await srv.db.delete(auditLog);
}

describe("runNotificationInboxRetention", () => {
  test("deletes rows past the retention window and keeps newer ones", async () => {
    await wipe();
    const old = await insertRow(
      new Date(NOW.getTime() - (RETENTION_DAYS + 5) * DAY_MS),
      "retention.old",
    );
    const edge = await insertRow(
      new Date(NOW.getTime() - (RETENTION_DAYS - 1) * DAY_MS),
      "retention.edge",
    );
    const fresh = await insertRow(new Date(NOW.getTime() - DAY_MS), "retention.fresh");

    await runNotificationInboxRetention(NOW, srv.db);

    const remaining = await inboxIds();
    expect(remaining).not.toContain(old);
    expect(remaining).toContain(edge);
    expect(remaining).toContain(fresh);
  });

  test("read marks cascade away with the row they point at", async () => {
    await wipe();
    const old = await insertRow(
      new Date(NOW.getTime() - (RETENTION_DAYS + 5) * DAY_MS),
      "retention.marked.old",
    );
    const fresh = await insertRow(new Date(NOW.getTime() - DAY_MS), "retention.marked.fresh");

    for (const inboxId of [old, fresh]) {
      await srv.db.insert(cliNotificationInboxReads).values({
        tenant_id: srv.tenantId,
        inbox_id: inboxId,
        user_id: srv.userId,
      });
    }

    await runNotificationInboxRetention(NOW, srv.db);

    const marks = await srv.db
      .select({ inbox_id: cliNotificationInboxReads.inbox_id })
      .from(cliNotificationInboxReads)
      .where(eq(cliNotificationInboxReads.tenant_id, srv.tenantId));
    expect(marks.map((m) => m.inbox_id)).toEqual([fresh]);
  });

  test("writes exactly one summary audit row carrying the deleted count", async () => {
    await wipe();
    await insertRow(new Date(NOW.getTime() - (RETENTION_DAYS + 5) * DAY_MS), "retention.audit.1");
    await insertRow(new Date(NOW.getTime() - (RETENTION_DAYS + 9) * DAY_MS), "retention.audit.2");
    await insertRow(new Date(NOW.getTime() - DAY_MS), "retention.audit.keep");

    await runNotificationInboxRetention(NOW, srv.db);

    const rows = await pruneAuditRows();
    expect(rows.length).toBe(1);
    const meta = rows[0]?.metadata as {
      sweep?: string;
      deleted?: number;
      retention_days?: number;
    } | null;
    expect(meta?.sweep).toBe("cli_notification_inbox");
    expect(meta?.deleted).toBe(2);
    expect(meta?.retention_days).toBe(RETENTION_DAYS);
    expect(rows[0]?.result).toBe("success");
  });

  test("a second sweep over the same data deletes nothing and still records itself", async () => {
    await wipe();
    await insertRow(new Date(NOW.getTime() - (RETENTION_DAYS + 5) * DAY_MS), "retention.twice");
    const keep = await insertRow(new Date(NOW.getTime() - DAY_MS), "retention.twice.keep");

    await runNotificationInboxRetention(NOW, srv.db);
    await runNotificationInboxRetention(NOW, srv.db);

    expect(await inboxIds()).toEqual([keep]);

    const rows = await pruneAuditRows();
    expect(rows.length).toBe(2);
    const deletedCounts = rows
      .map((r) => (r.metadata as { deleted?: number } | null)?.deleted)
      .sort();
    expect(deletedCounts).toEqual([0, 1]);
  });

  test("the sweep is cross-tenant by design and audits under the system tenant", async () => {
    await wipe();
    await insertRow(new Date(NOW.getTime() - (RETENTION_DAYS + 5) * DAY_MS), "retention.system");

    await runNotificationInboxRetention(NOW, srv.db);

    const rows = await srv.db
      .select({ tenant_id: auditLog.tenant_id, actor_type: auditLog.actor_type })
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "notification.inbox_pruned"), eq(auditLog.actor_type, "system")),
      );
    expect(rows.length).toBe(1);
    expect(rows[0]?.tenant_id).not.toBe(srv.tenantId);
  });
});
