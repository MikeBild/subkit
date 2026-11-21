import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog } from "../../db/schema/audit.ts";
import { cliNotificationInbox, cliNotificationInboxReads } from "../../db/schema/notifications.ts";
import { createHttpTestServer, type HttpTestServer } from "../../http/tests/setup.ts";
import {
  NOTIFICATION_INBOX_RETENTION_BATCH_SIZE,
  runNotificationInboxRetention,
} from "../../notifications/scheduled/notification-inbox-retention-runner.ts";
import { createDeterministicUuidFactory } from "../../test-helpers/determinism/ids.ts";
import { seedTenant } from "../../test-helpers/seed.ts";

let srv: HttpTestServer;
const ids = createDeterministicUuidFactory(0x72657461);
const neighborTenantId = ids();

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-03-01T12:00:00.000Z");
const RETENTION_DAYS = 30;

async function insertRow(
  createdAt: Date,
  eventType: string,
  tenantId = srv.tenantId,
): Promise<number> {
  const [row] = await srv.db
    .insert(cliNotificationInbox)
    .values({
      tenant_id: tenantId,
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
  await seedTenant(srv.db, {
    id: neighborTenantId,
    slug: "retention-neighbor",
    display_name: "Retention neighbor",
  });
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
      request_source?: string;
      deleted?: number;
      retention_days?: number;
    } | null;
    expect(meta?.sweep).toBe("cli_notification_inbox");
    expect(meta?.request_source).toBe("scheduler");
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
    const neighborOld = await insertRow(
      new Date(NOW.getTime() - (RETENTION_DAYS + 5) * DAY_MS),
      "retention.neighbor.old",
      neighborTenantId,
    );
    const neighborFresh = await insertRow(
      new Date(NOW.getTime() - DAY_MS),
      "retention.neighbor.fresh",
      neighborTenantId,
    );

    await runNotificationInboxRetention(NOW, srv.db);

    const rows = await srv.db
      .select({ tenant_id: auditLog.tenant_id, actor_type: auditLog.actor_type })
      .from(auditLog)
      .where(
        and(eq(auditLog.action, "notification.inbox_pruned"), eq(auditLog.actor_type, "system")),
      );
    expect(rows.length).toBe(1);
    expect(rows[0]?.tenant_id).not.toBe(srv.tenantId);
    const neighborRows = await srv.db
      .select({ id: cliNotificationInbox.id })
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, neighborTenantId));
    expect(neighborRows.map((row) => row.id)).toEqual([neighborFresh]);
    expect(neighborRows.map((row) => row.id)).not.toContain(neighborOld);
  });
  test("each tick removes at most one fixed batch and repeated ticks drain the backlog", async () => {
    await wipe();
    const oldCount = NOTIFICATION_INBOX_RETENTION_BATCH_SIZE * 2 + 7;
    const createdAt = new Date(NOW.getTime() - (RETENTION_DAYS + 5) * DAY_MS);
    const old = await srv.db
      .insert(cliNotificationInbox)
      .values(
        Array.from({ length: oldCount }, () => ({
          tenant_id: srv.tenantId,
          severity: "info",
          event_type: "retention.backlog",
          event_payload: { test: true },
          created_at: createdAt,
        })),
      )
      .returning({ id: cliNotificationInbox.id });
    const boundary = await insertRow(
      new Date(NOW.getTime() - RETENTION_DAYS * DAY_MS),
      "retention.exact-boundary",
    );
    const fresh = await insertRow(new Date(NOW.getTime() - DAY_MS), "retention.backlog.fresh");
    for (const remainingOld of [oldCount - NOTIFICATION_INBOX_RETENTION_BATCH_SIZE, 7, 0]) {
      await runNotificationInboxRetention(NOW, srv.db);
      const remaining = await inboxIds();
      expect(remaining).toHaveLength(remainingOld + 2);
      expect(remaining).toContain(boundary);
      expect(remaining).toContain(fresh);
      const removed = old.filter((row) => !remaining.includes(row.id));
      expect(removed.map((row) => row.id)).toEqual(
        old.slice(0, oldCount - remainingOld).map((row) => row.id),
      );
    }
    const counts = (await pruneAuditRows())
      .map((row) => (row.metadata as { deleted: number }).deleted)
      .sort((a, b) => a - b);
    expect(counts).toEqual([
      7,
      NOTIFICATION_INBOX_RETENTION_BATCH_SIZE,
      NOTIFICATION_INBOX_RETENTION_BATCH_SIZE,
    ]);
  });

  test("locked expired rows are skipped and remain eligible on the next tick", async () => {
    await wipe();
    const locked = await insertRow(
      new Date(NOW.getTime() - (RETENTION_DAYS + 9) * DAY_MS),
      "retention.locked",
    );
    const available = await insertRow(
      new Date(NOW.getTime() - (RETENTION_DAYS + 5) * DAY_MS),
      "retention.available",
    );
    const fresh = await insertRow(new Date(NOW.getTime() - DAY_MS), "retention.locked.fresh");
    const client = await srv.testDb.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "SELECT id FROM subkit.cli_notification_inbox WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
        [locked, srv.tenantId],
      );
      await runNotificationInboxRetention(NOW, srv.db);
      const remaining = await inboxIds();
      expect(remaining).toContain(locked);
      expect(remaining).not.toContain(available);
      expect(remaining).toContain(fresh);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
    await runNotificationInboxRetention(NOW, srv.db);
    expect(await inboxIds()).toEqual([fresh]);
    expect(
      (await pruneAuditRows()).map((row) => (row.metadata as { deleted: number }).deleted),
    ).toEqual([1, 1]);
  }, 10000);

  test("mandatory summary audit failure rolls back deletion and cascading read marks", async () => {
    await wipe();
    const old = await insertRow(
      new Date(NOW.getTime() - (RETENTION_DAYS + 5) * DAY_MS),
      "retention.rollback",
    );
    const fresh = await insertRow(new Date(NOW.getTime() - DAY_MS), "retention.rollback.fresh");
    await srv.db
      .insert(cliNotificationInboxReads)
      .values({ tenant_id: srv.tenantId, inbox_id: old, user_id: srv.userId });
    await srv.testDb.pool.query(
      "CREATE FUNCTION subkit.test_retention_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='notification.inbox_pruned' THEN RAISE EXCEPTION 'synthetic_retention_audit_failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_retention_audit_failure BEFORE INSERT ON subkit.audit_log FOR EACH ROW EXECUTE FUNCTION subkit.test_retention_audit_failure()",
    );
    try {
      await runNotificationInboxRetention(NOW, srv.db);
      expect(await inboxIds()).toEqual([old, fresh]);
      const marks = await srv.db
        .select({ inbox_id: cliNotificationInboxReads.inbox_id })
        .from(cliNotificationInboxReads)
        .where(eq(cliNotificationInboxReads.tenant_id, srv.tenantId));
      expect(marks).toEqual([{ inbox_id: old }]);
      expect(await pruneAuditRows()).toHaveLength(0);
    } finally {
      await srv.testDb.pool.query(
        "DROP TRIGGER test_retention_audit_failure ON subkit.audit_log; DROP FUNCTION subkit.test_retention_audit_failure()",
      );
    }
  });
});
