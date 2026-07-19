// Integration tests for runConnectorReauthScanForTenant.
//
// The scan makes live HTTP probes — we use node:http createMockServer on an
// ephemeral port so each scenario can return a real 401 or 200 without a full
// engine execution.
//
// Coverage:
//   - 401 probe (with a seeded credential) → connector flagged + 1
//     connector.auth_failed event.
//   - bearer connector with NO credential row → credential_missing, NOT flagged.
//   - 200 probe (with credential) → connector stays healthy (no event, no flag).
//   - Already-flagged connector is skipped (needs_reauth=true is excluded from
//     the candidate selection); a second scan must NOT emit a second event.
//   - Tenant isolation: the scan is scoped to a single tenant; a connector
//     belonging to another tenant must not be affected.
//   - Runtime streak escalation: 3 consecutive auth_failed scheduler runs on
//     a schedule-bound workflow emit a level:"error" line naming workflow +
//     connector; shorter/broken streaks and paused schedules stay silent.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { upsertCredential } from "../../credentials/service.ts";
import {
  connectors,
  events,
  executionSteps,
  executions,
  tenants,
  workflows,
  workflowsSchedules,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { logRing } from "../../observability/log-ring.ts";
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

/**
 * Seed a bearer credential for a connector so probeHttpConnector will
 * proceed past the credential-required guard and reach the target server.
 * Without this, the probe returns credential_missing (not credential_invalid)
 * and the connector is never flagged.
 */
async function seedBearerCredential(opts: {
  tenantId: string;
  connectorId: string;
}): Promise<void> {
  await upsertCredential(
    {
      tenant_id: opts.tenantId,
      connector_id: opts.connectorId,
      environment: "dev",
      mode: "bearer",
      value: { mode: "bearer", token: "test-token" },
      actor_id: null,
    },
    db.db,
  );
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
    // Point the connector at the always-401 server and seed a credential so
    // probeHttpConnector proceeds past the credential-required guard and
    // actually reaches the server, getting back a 401 that classifies as
    // credential_invalid.
    const connectorId = await seedConnector({
      slug: "scan-401",
      base_url: unauthBaseUrl,
    });
    await seedBearerCredential({ tenantId, connectorId });

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

describe("runConnectorReauthScanForTenant — bearer connector with no credential", () => {
  test("connector with auth_type bearer but no credential row is not flagged (credential_missing)", async () => {
    // Seed a bearer connector with NO credential row — the probe returns
    // credential_missing, not credential_invalid. The runner must NOT flag it
    // because a missing credential is not the same as a dead one.
    const connectorId = await seedConnector({
      slug: "scan-no-cred",
      base_url: unauthBaseUrl,
    });
    // Intentionally: no seedBearerCredential call here.

    const eventsBefore = await queryAuthFailedEventsForTenant(tenantId);
    const countBefore = eventsBefore.length;

    await runConnectorReauthScanForTenant(tenantId, NOW, db.db);

    const rows = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(rows[0]!.needs_reauth).toBe(false);
    expect(rows[0]!.auth_failed_at).toBeNull();

    // No event emitted for credential_missing.
    const eventsAfter = await queryAuthFailedEventsForTenant(tenantId);
    expect(eventsAfter.length).toBe(countBefore);
  });
});

describe("runConnectorReauthScanForTenant — 200 connector untouched", () => {
  test("connector whose probe returns 200 stays healthy", async () => {
    const connectorId = await seedConnector({
      slug: "scan-200",
      base_url: okBaseUrl,
    });
    await seedBearerCredential({ tenantId, connectorId });

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

// ---------------------------------------------------------------------------
// runtime auth_failed streak escalation (second scan phase)
// ---------------------------------------------------------------------------

/**
 * Seed a schedule-bound workflow plus `failures` consecutive failed
 * scheduler executions, each with a failed request step whose error carries
 * `health: "auth_failed"` — the shape the request dispatcher persists on a
 * 401/403 (see execution/steps/request/dispatch.ts healthHintMeta).
 * `finalStatus` overrides the NEWEST execution (e.g. "succeeded" to prove a
 * recovered workflow breaks the streak).
 */
async function seedAuthFailedStreak(opts: {
  slug: string;
  failures: number;
  connectorSlug?: string;
  finalStatus?: "succeeded" | "failed";
  paused?: boolean;
}): Promise<{ workflowId: string }> {
  const [w] = await db.db
    .insert(workflows)
    .values({
      tenant_id: tenantId,
      slug: opts.slug,
      name: opts.slug,
      lifecycle: "active",
    })
    .returning();
  const workflowId = w!.id;
  await db.db.insert(workflowsSchedules).values({
    tenant_id: tenantId,
    workflow_id: workflowId,
    cron: "0 8,20 * * *",
    paused: opts.paused ?? false,
  });

  const connectorSlug = opts.connectorSlug ?? "streak-connector";
  for (let i = 0; i < opts.failures; i += 1) {
    const isNewest = i === opts.failures - 1;
    const status = isNewest ? (opts.finalStatus ?? "failed") : "failed";
    const startedAt = new Date(NOW.getTime() - (opts.failures - i) * 12 * 3600_000);
    const [e] = await db.db
      .insert(executions)
      .values({
        tenant_id: tenantId,
        workflow_id: workflowId,
        status,
        request_source: "scheduler",
        execution_mode: "prod",
        started_at: startedAt,
        finished_at: new Date(startedAt.getTime() + 1000),
      })
      .returning();
    if (status === "failed") {
      await db.db.insert(executionSteps).values({
        tenant_id: tenantId,
        execution_id: e!.id,
        step_key: "scrape",
        kind: "request",
        status: "failed",
        error: { code: "http_4xx", message: "http 401", health: "auth_failed" },
        request_meta: {
          connector: {
            connector_id: "00000000-0000-0000-0000-00000000c0fe",
            connector_slug: connectorSlug,
          },
        },
        started_at: startedAt,
      });
    }
  }
  return { workflowId };
}

function tailStreakErrors() {
  return logRing.tail({
    module: "scheduler",
    action: "connector_reauth_scan.workflow_auth_failed",
    min_level: "error",
  });
}

describe("runConnectorReauthScanForTenant — scheduled auth_failed streak", () => {
  test("3 consecutive auth_failed scheduler runs emit one error naming workflow + connector", async () => {
    const { workflowId } = await seedAuthFailedStreak({
      slug: "streak-3-failed",
      failures: 3,
      connectorSlug: "streak-browserless",
    });

    logRing.clear();
    await runConnectorReauthScanForTenant(tenantId, NOW, db.db);

    const entries = tailStreakErrors().filter((e) => e.fields.workflow_id === workflowId);
    expect(entries.length).toBe(1);
    expect(entries[0]!.level).toBe("error");
    expect(entries[0]!.fields.workflow_slug).toBe("streak-3-failed");
    expect(entries[0]!.fields.connector_slug).toBe("streak-browserless");
    expect(entries[0]!.fields.consecutive_failures).toBe(3);
  });

  test("only 2 consecutive failures stay below the threshold — no error", async () => {
    const { workflowId } = await seedAuthFailedStreak({
      slug: "streak-2-failed",
      failures: 2,
    });

    logRing.clear();
    await runConnectorReauthScanForTenant(tenantId, NOW, db.db);

    const entries = tailStreakErrors().filter((e) => e.fields.workflow_id === workflowId);
    expect(entries.length).toBe(0);
  });

  test("a succeeded newest run breaks the streak — no error", async () => {
    const { workflowId } = await seedAuthFailedStreak({
      slug: "streak-recovered",
      failures: 4,
      finalStatus: "succeeded",
    });

    logRing.clear();
    await runConnectorReauthScanForTenant(tenantId, NOW, db.db);

    const entries = tailStreakErrors().filter((e) => e.fields.workflow_id === workflowId);
    expect(entries.length).toBe(0);
  });

  test("a paused schedule does not alert", async () => {
    const { workflowId } = await seedAuthFailedStreak({
      slug: "streak-paused",
      failures: 3,
      paused: true,
    });

    logRing.clear();
    await runConnectorReauthScanForTenant(tenantId, NOW, db.db);

    const entries = tailStreakErrors().filter((e) => e.fields.workflow_id === workflowId);
    expect(entries.length).toBe(0);
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
    // Seed a credential for the other tenant's connector so, if the scan
    // incorrectly crosses the tenant boundary, the probe would reach 401
    // and flag it — making the isolation assertion meaningful.
    await seedBearerCredential({ tenantId: otherTenantId, connectorId: otherConnectorId });

    // Run scan only for tenantId (NOT otherTenantId).
    await runConnectorReauthScanForTenant(tenantId, NOW, db.db);

    // The other tenant's connector must be untouched.
    const rows = await db.db.select().from(connectors).where(eq(connectors.id, otherConnectorId));
    expect(rows[0]!.needs_reauth).toBe(false);
    expect(rows[0]!.auth_failed_at).toBeNull();
  });
});
