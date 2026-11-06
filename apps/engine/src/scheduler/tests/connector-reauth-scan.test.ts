import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { upsertCredential } from "../../credentials/service.ts";
import {
  connectorMcpSessions,
  connectors,
  events,
  executionSteps,
  executions,
  workflows,
  workflowsSchedules,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { logRing } from "../../observability/log-ring.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../test-helpers/mock-http.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { runConnectorReauthScanForTenant } from "../connector-reauth-scan-runner.ts";

const NOW = new Date("2026-06-01T00:00:00.000Z");

let db: TestDb;
let tenantId: string;
let otherTenantId: string;

let mockServer401: MockServer;
let mockServer200: MockServer;
let unauthBaseUrl: string;
let okBaseUrl: string;

beforeAll(async () => {
  db = await createTestDb("reauth-scan");

  const t = await seedTenant(db.db, { slug: "t-scan", display_name: "Scan Tenant" });
  tenantId = t.id;

  const t2 = await seedTenant(db.db, { slug: "t-scan-other", display_name: "Other Tenant" });
  otherTenantId = t2.id;

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

async function seedConnector(opts: {
  slug: string;
  tenantIdOverride?: string;
  base_url?: string;
  needs_reauth?: boolean;
  auth_type?: string;
  config?: Record<string, unknown>;
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
      config: opts.config ?? {},
      needs_reauth: opts.needs_reauth ?? false,
    })
    .returning();
  return c!.id;
}

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

describe("runConnectorReauthScanForTenant — 401 connector flagged", () => {
  test("connector whose configured probe returns 401 is flagged and emits one event", async () => {
    const connectorId = await seedConnector({
      slug: "scan-401",
      base_url: unauthBaseUrl,
      config: {
        probe_endpoint: { method: "GET", path: "/users/me", expected_status: [200, 200] },
      },
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

describe("runConnectorReauthScanForTenant — root answers 401 without a probe_endpoint", () => {
  test("an unverified fallback probe does not flag the connector or emit an event", async () => {
    const connectorId = await seedConnector({
      slug: "scan-401-root",
      base_url: unauthBaseUrl,
    });
    await seedBearerCredential({ tenantId, connectorId });

    const countBefore = (await queryAuthFailedEventsForTenant(tenantId)).length;

    await runConnectorReauthScanForTenant(tenantId, NOW, db.db);

    const rows = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(rows[0]!.needs_reauth).toBe(false);
    expect(rows[0]!.auth_failed_at).toBeNull();
    const after = await queryAuthFailedEventsForTenant(tenantId);
    const mine = after
      .slice(countBefore)
      .filter((e) => (e.payload as { connector_id?: string }).connector_id === connectorId);
    expect(mine).toHaveLength(0);
  });
});

describe("runConnectorReauthScanForTenant — bearer connector with no credential", () => {
  test("connector with auth_type bearer but no credential row is not flagged (credential_missing)", async () => {
    const connectorId = await seedConnector({
      slug: "scan-no-cred",
      base_url: unauthBaseUrl,
    });

    const eventsBefore = await queryAuthFailedEventsForTenant(tenantId);
    const countBefore = eventsBefore.length;

    await runConnectorReauthScanForTenant(tenantId, NOW, db.db);

    const rows = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(rows[0]!.needs_reauth).toBe(false);
    expect(rows[0]!.auth_failed_at).toBeNull();

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

    const eventsAfter = await queryAuthFailedEventsForTenant(tenantId);
    expect(eventsAfter.length).toBe(countBefore);
  });
});

describe("runConnectorReauthScanForTenant — already-flagged connector skipped", () => {
  test("a connector that already has needs_reauth=true is excluded from candidates and emits no second event", async () => {
    const connectorId = await seedConnector({
      slug: "scan-preflagged",
      base_url: unauthBaseUrl,
      needs_reauth: true,
    });

    const eventsBefore = await queryAuthFailedEventsForTenant(tenantId);
    const countBefore = eventsBefore.length;

    await runConnectorReauthScanForTenant(tenantId, NOW, db.db);

    const rows = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(rows[0]!.needs_reauth).toBe(true);

    const eventsAfter = await queryAuthFailedEventsForTenant(tenantId);
    expect(eventsAfter.length).toBe(countBefore);
  });
});

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
    const otherConnectorId = await seedConnector({
      slug: "scan-other-tenant",
      base_url: unauthBaseUrl,
      tenantIdOverride: otherTenantId,
    });
    await seedBearerCredential({ tenantId: otherTenantId, connectorId: otherConnectorId });

    await runConnectorReauthScanForTenant(tenantId, NOW, db.db);

    const rows = await db.db.select().from(connectors).where(eq(connectors.id, otherConnectorId));
    expect(rows[0]!.needs_reauth).toBe(false);
    expect(rows[0]!.auth_failed_at).toBeNull();
  });
});

describe("runConnectorReauthScanForTenant — driver mcp is excluded", () => {
  test("an enabled mcp connector gets no handshake and is not parked by the sweep", async () => {
    let hits = 0;
    const mcpServer = await createMockServer((_req, res) => {
      hits += 1;
      jsonResponse(res, 500, { error: "should never be asked" });
    });
    try {
      const [c] = await db.db
        .insert(connectors)
        .values({
          tenant_id: tenantId,
          slug: "scan-mcp-remote",
          display_name: "scan-mcp-remote",
          driver: "mcp",
          environment: "prod",
          auth_type: "bearer",
          base_url: mcpServer.baseUrl,
          config: { mcp: { transport: "http", auth: { kind: "bearer" } } },
        })
        .returning();
      const connectorId = c!.id;
      await upsertCredential(
        {
          tenant_id: tenantId,
          connector_id: connectorId,
          environment: "prod",
          mode: "bearer",
          value: { mode: "bearer", token: "test-token" },
          actor_id: null,
        },
        db.db,
      );

      logRing.clear();
      await runConnectorReauthScanForTenant(tenantId, NOW, db.db);

      expect(hits).toBe(0);

      const [row] = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
      expect(row!.last_error).toBeNull();
      expect(row!.health_state).toBe("ok");
      expect(row!.needs_reauth).toBe(false);

      const sessions = await db.db
        .select()
        .from(connectorMcpSessions)
        .where(eq(connectorMcpSessions.connector_id, connectorId));
      expect(sessions).toHaveLength(0);

      const completed = logRing.tail({
        module: "scheduler",
        action: "connector_reauth_scan.completed",
      });
      expect(completed.at(-1)?.fields.mcp_not_probed).toBe(1);
    } finally {
      await mcpServer.close();
    }
  });
});
