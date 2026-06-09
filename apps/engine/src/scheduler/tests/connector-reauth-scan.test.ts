// Integration tests for runConnectorReauthScanForTenant.
//
// The scan makes live HTTP probes — we use Bun.serve on an ephemeral port so
// each scenario can return a real 401 or 200 without a full engine execution.
//
// Coverage:
//   - 401 probe → connector flagged + 1 connector.auth_failed event.
//   - 200 probe → connector stays healthy (no event, no flag).
//   - Already-flagged connector is skipped (needs_reauth=true is excluded from
//     the candidate selection); a second scan must NOT emit a second event.
//   - Tenant isolation: the scan is scoped to a single tenant; a connector
//     belonging to another tenant must not be affected.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { connectors, events, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../test-helpers/mock-http.ts";
import { runConnectorReauthScanForTenant } from "../connector-reauth-scan-runner.ts";

// Fixed scan timestamp — the runner only uses `now` for duration logging, so a
// frozen value keeps the test deterministic (no argless `new Date()`).
const NOW = new Date("2026-06-01T00:00:00.000Z");

let db: TestDb;
let tenantId: string;
let otherTenantId: string;

// Two ephemeral node:http servers (createMockServer) — one always returns 401,
// one always returns 200. node:http is the repo's stable mock pattern; Bun.serve
// is avoided here because, under the full-suite run, fetch can bleed across
// concurrent Bun.serve instances and return a stray response from another
// server. Two separate servers (rather than path routing) avoids URL-resolution
// ambiguity: resolveUrl(base_url, "/") hits the server root regardless of path.
let mockServer401: MockServer;
let mockServer200: MockServer;
let unauthBaseUrl: string;
let okBaseUrl: string;

beforeAll(async () => {
  db = await createTestDb("reauth-scan");

  const [t] = await db.db
    .insert(tenants)
    .values({ slug: "t-scan", display_name: "Scan Tenant" })
    .returning();
  tenantId = t!.id;

  const [t2] = await db.db
    .insert(tenants)
    .values({ slug: "t-scan-other", display_name: "Other Tenant" })
    .returning();
  otherTenantId = t2!.id;

  mockServer401 = await createMockServer((_req, res) => {
    jsonResponse(res, 401, { error: "unauthorized" });
  });
  mockServer200 = await createMockServer((_req, res) => {
    jsonResponse(res, 200, { ok: true });
  });
  unauthBaseUrl = mockServer401.baseUrl;
  okBaseUrl = mockServer200.baseUrl;
});

afterAll(async () => {
  await mockServer401.close();
  await mockServer200.close();
  await db.cleanup();
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

async function seedConnector(opts: {
  slug: string;
  tenantIdOverride?: string;
  base_url?: string;
  needs_reauth?: boolean;
  auth_type?: string;
}): Promise<string> {
  const [c] = await db.db
    .insert(connectors)
    .values({
      tenant_id: opts.tenantIdOverride ?? tenantId,
      slug: opts.slug,
      display_name: opts.slug,
      driver: "http",
      environment: "dev",
      auth_type: (opts.auth_type ?? "bearer") as "bearer",
      base_url: opts.base_url ?? okBaseUrl,
      config: {},
      needs_reauth: opts.needs_reauth ?? false,
    })
    .returning();
  return c!.id;
}

async function queryAuthFailedEventsForTenant(tid: string) {
  return db.db
    .select()
    .from(events)
    .where(and(eq(events.tenant_id, tid), eq(events.type, "connector.auth_failed")));
}

// ---------------------------------------------------------------------------
// tests
// ---------------------------------------------------------------------------

describe("runConnectorReauthScanForTenant — 401 connector flagged", () => {
  test("connector whose probe returns 401 is flagged and emits one event", async () => {
    // Point the connector at the always-401 server.
    const connectorId = await seedConnector({
      slug: "scan-401",
      base_url: unauthBaseUrl,
    });

    const eventsBefore = await queryAuthFailedEventsForTenant(tenantId);
    const countBefore = eventsBefore.length;

    await runConnectorReauthScanForTenant(tenantId, NOW, db.db);

    const rows = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(rows[0]!.needs_reauth).toBe(true);
    expect(rows[0]!.auth_failed_at).not.toBeNull();

    const eventsAfter = await queryAuthFailedEventsForTenant(tenantId);
    const newEvents = eventsAfter.slice(countBefore);
    expect(newEvents.length).toBe(1);
    const payload = newEvents[0]!.payload as { connector_id?: string; severity?: string };
    expect(payload.connector_id).toBe(connectorId);
    expect(payload.severity).toBe("error");
  });
});

describe("runConnectorReauthScanForTenant — 200 connector untouched", () => {
  test("connector whose probe returns 200 stays healthy", async () => {
    const connectorId = await seedConnector({
      slug: "scan-200",
      base_url: okBaseUrl,
    });

    const eventsBefore = await queryAuthFailedEventsForTenant(tenantId);
    const countBefore = eventsBefore.length;

    await runConnectorReauthScanForTenant(tenantId, NOW, db.db);

    const rows = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(rows[0]!.needs_reauth).toBe(false);

    // No new event emitted.
    const eventsAfter = await queryAuthFailedEventsForTenant(tenantId);
    expect(eventsAfter.length).toBe(countBefore);
  });
});

describe("runConnectorReauthScanForTenant — already-flagged connector skipped", () => {
  test("a connector that already has needs_reauth=true is excluded from candidates and emits no second event", async () => {
    // Insert the connector already flagged — the scan WHERE clause
    // excludes needs_reauth=true rows, so this connector must be skipped
    // entirely, producing no additional event.
    const connectorId = await seedConnector({
      slug: "scan-preflagged",
      base_url: unauthBaseUrl,
      needs_reauth: true,
    });

    const eventsBefore = await queryAuthFailedEventsForTenant(tenantId);
    const countBefore = eventsBefore.length;

    await runConnectorReauthScanForTenant(tenantId, NOW, db.db);

    // Row still flagged (scan did nothing).
    const rows = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(rows[0]!.needs_reauth).toBe(true);

    // No new event.
    const eventsAfter = await queryAuthFailedEventsForTenant(tenantId);
    expect(eventsAfter.length).toBe(countBefore);
  });
});

describe("runConnectorReauthScanForTenant — tenant isolation", () => {
  test("scan for tenant A does not affect a connector owned by tenant B", async () => {
    // Connector belonging to the other tenant, pointing at the always-401 server.
    const otherConnectorId = await seedConnector({
      slug: "scan-other-tenant",
      base_url: unauthBaseUrl,
      tenantIdOverride: otherTenantId,
    });

    // Run scan only for tenantId (NOT otherTenantId).
    await runConnectorReauthScanForTenant(tenantId, NOW, db.db);

    // The other tenant's connector must be untouched.
    const rows = await db.db.select().from(connectors).where(eq(connectors.id, otherConnectorId));
    expect(rows[0]!.needs_reauth).toBe(false);
    expect(rows[0]!.auth_failed_at).toBeNull();
  });
});
