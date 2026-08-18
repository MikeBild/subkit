// SkCliAdapter unit/integration tests.
//
// Uses a real disposable Postgres database (createTestDb pattern) — the
// adapter's entire contract is a DB INSERT, so no meaningful behavior can
// be observed without touching the actual schema.
//
// Covers:
//   - send() inserts exactly ONE cli_notification_inbox row scoped to
//     delivery.tenant_id, with the severity / event_type / event_payload
//     carried from delivery.notification.
//   - Returns { platform_message_id } = the row's bigserial id (as string).
//   - A second send() adds a second row; the cursor advances monotonically.
//   - Cross-tenant isolation: a delivery for tenant A never appears in
//     tenant B's inbox.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { tenants } from "../../db/schema/index.ts";
import { cliNotificationInbox } from "../../db/schema/notifications.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { classifyEvent } from "../../webhooks/events/catalog.ts";
import type { ChatDelivery } from "../types.ts";
import { SkCliAdapter } from "./adapter.ts";

let testDb: TestDb;
let tenantAId: string;
let tenantBId: string;

beforeAll(async () => {
  testDb = await createTestDb("sk_cli_adapter");
  const [tA] = await testDb.db
    .insert(tenants)
    .values({ slug: "sk-cli-a", display_name: "SK CLI A" })
    .returning();
  if (!tA) throw new Error("seed tenant A failed");
  tenantAId = tA.id;

  const [tB] = await testDb.db
    .insert(tenants)
    .values({ slug: "sk-cli-b", display_name: "SK CLI B" })
    .returning();
  if (!tB) throw new Error("seed tenant B failed");
  tenantBId = tB.id;
}, 30_000);

afterAll(async () => {
  await testDb.cleanup();
}, 30_000);

function makeDelivery(
  tenantId: string,
  opts: {
    severity?: string;
    event_type?: string;
    event_payload?: Record<string, unknown> | null;
  } = {},
): ChatDelivery {
  return {
    tenant_id: tenantId,
    workspace_id: "_cli",
    channel_id: "_inbox",
    kind: "message",
    text: `[${opts.severity ?? "info"}] ${opts.event_type ?? "notification"}`,
    notification: {
      severity: opts.severity ?? "info",
      event_type: opts.event_type ?? "notification",
      event_payload: opts.event_payload ?? null,
    },
  };
}

describe("SkCliAdapter.send", () => {
  test("inserts exactly one cli_notification_inbox row for the delivery's tenant", async () => {
    const adapter = new SkCliAdapter(testDb.db);
    const before = await testDb.db
      .select()
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, tenantAId));

    const result = await adapter.send(
      makeDelivery(tenantAId, {
        severity: "error",
        event_type: "connector.auth_failed",
        event_payload: { connector_id: "c-abc" },
      }),
    );

    const after = await testDb.db
      .select()
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, tenantAId));

    expect(after.length).toBe(before.length + 1);

    const row = after.find((r) => String(r.id) === result.platform_message_id);
    expect(row).toBeDefined();
    expect(row?.severity).toBe("error");
    expect(row?.event_type).toBe("connector.auth_failed");
    expect(row?.event_payload).toMatchObject({ connector_id: "c-abc" });
  });

  test("returns { platform_message_id } equal to the inserted row's id", async () => {
    const adapter = new SkCliAdapter(testDb.db);
    const result = await adapter.send(makeDelivery(tenantAId, { event_type: "test.event" }));
    expect(typeof result.platform_message_id).toBe("string");
    // The id should parse to a positive integer.
    const id = Number(result.platform_message_id);
    expect(Number.isInteger(id) && id > 0).toBe(true);
  });

  test("second send adds a second row and the cursor advances monotonically", async () => {
    const adapter = new SkCliAdapter(testDb.db);
    const r1 = await adapter.send(makeDelivery(tenantAId, { event_type: "cursor.test.1" }));
    const r2 = await adapter.send(makeDelivery(tenantAId, { event_type: "cursor.test.2" }));

    const id1 = Number(r1.platform_message_id);
    const id2 = Number(r2.platform_message_id);
    expect(id2).toBeGreaterThan(id1);
  });

  test("cross-tenant isolation: a delivery for tenant A does not appear in tenant B", async () => {
    const adapter = new SkCliAdapter(testDb.db);
    const r = await adapter.send(
      makeDelivery(tenantAId, { event_type: "isolation.test", severity: "warn" }),
    );

    const inboxB = await testDb.db
      .select()
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, tenantBId));

    const leaked = inboxB.find((row) => String(row.id) === r.platform_message_id);
    expect(leaked).toBeUndefined();
  });

  test("severity and event_payload from delivery.notification are persisted verbatim", async () => {
    const adapter = new SkCliAdapter(testDb.db);
    const payload = { workflow_id: "wf-123", status: "failed", retries: 3 };
    const result = await adapter.send(
      makeDelivery(tenantAId, {
        severity: "critical",
        event_type: "execution.failed",
        event_payload: payload,
      }),
    );

    const rows = await testDb.db
      .select()
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, tenantAId));
    const row = rows.find((r) => String(r.id) === result.platform_message_id);
    expect(row?.severity).toBe("critical");
    expect(row?.event_type).toBe("execution.failed");
    expect(row?.event_payload).toMatchObject(payload);
  });

  test("delivery without notification fields uses defaults (severity=info, event_type=notification)", async () => {
    const adapter = new SkCliAdapter(testDb.db);
    // Delivery with no .notification field at all.
    const bare: ChatDelivery = {
      tenant_id: tenantAId,
      workspace_id: "_cli",
      channel_id: "_inbox",
      kind: "message",
      text: "bare delivery",
    };
    const result = await adapter.send(bare);

    const rows = await testDb.db
      .select()
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, tenantAId));
    const row = rows.find((r) => String(r.id) === result.platform_message_id);
    expect(row?.severity).toBe("info");
    expect(row?.event_type).toBe("notification");
  });

  test("persists the classifier's verdict on insert", async () => {
    const adapter = new SkCliAdapter(testDb.db);
    const connectorId = "00000000-0000-4000-8000-00000000ca11";
    const result = await adapter.send(
      makeDelivery(tenantAId, {
        severity: "error",
        event_type: "connector.auth_failed",
        event_payload: { connector_id: connectorId, reason: "credential_rejected" },
      }),
    );

    const rows = await testDb.db
      .select()
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, tenantAId));
    const row = rows.find((r) => String(r.id) === result.platform_message_id);
    const expected = classifyEvent("connector.auth_failed", {
      connector_id: connectorId,
      reason: "credential_rejected",
    });
    expect(expected.actionable).toBe(true);
    expect(row?.actionable).toBe(expected.actionable);
    expect(row?.resource_type).toBe(expected.resource_type);
    expect(row?.resource_id).toBe(expected.resource_id);
  });

  test("an unclassifiable event type persists as not actionable, pointing at nothing", async () => {
    const adapter = new SkCliAdapter(testDb.db);
    const result = await adapter.send(
      makeDelivery(tenantAId, {
        event_type: "not.a.catalog.event",
        event_payload: { connector_id: "00000000-0000-4000-8000-00000000ca12" },
      }),
    );

    const rows = await testDb.db
      .select()
      .from(cliNotificationInbox)
      .where(eq(cliNotificationInbox.tenant_id, tenantAId));
    const row = rows.find((r) => String(r.id) === result.platform_message_id);
    expect(row?.actionable).toBe(false);
    expect(row?.resource_type).toBeNull();
    expect(row?.resource_id).toBeNull();
  });
});
