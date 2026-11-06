import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, connectors, events, workflows } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { seedConnector, seedTenant } from "../test-helpers/seed.ts";
import {
  clearConnectorHealthOnSuccess,
  effectiveConnectorHealth,
  flagConnectorContractFailure,
  setConnectorHealth,
  setWorkflowHealth,
} from "./health-state.ts";

let db: TestDb;
let tenantId: string;

beforeAll(async () => {
  db = await createTestDb("health-state-unit");
  tenantId = (await seedTenant(db.db, { slug: "t-health", display_name: "Health Tenant" })).id;
});

afterAll(async () => {
  await db.cleanup();
});

async function seedHealthConnector(
  slug: string,
): Promise<{ id: string; tenant_id: string; slug: string }> {
  const c = await seedConnector(db.db, { tenant_id: tenantId, slug, display_name: slug });
  return { id: c.id, tenant_id: tenantId, slug };
}

async function connectorRow(id: string) {
  const rows = await db.db.select().from(connectors).where(eq(connectors.id, id));
  return rows[0]!;
}

async function healthChangedEvents() {
  return db.db
    .select()
    .from(events)
    .where(and(eq(events.tenant_id, tenantId), eq(events.type, "connector.health_changed")));
}

describe("setConnectorHealth", () => {
  test("transition edge writes state + emits one notification event + one audit row", async () => {
    const c = await seedHealthConnector("hs-basic");
    const before = (await healthChangedEvents()).length;

    const r1 = await setConnectorHealth(db.db, c, {
      state: "degraded",
      reason: "vendor 5xx streak",
      error_code: "vendor_degraded",
    });
    expect(r1.transitioned).toBe(true);

    const row = await connectorRow(c.id);
    expect(row.health_state).toBe("degraded");
    expect(row.health_reason).toBe("vendor 5xx streak");
    expect(row.health_error_code).toBe("vendor_degraded");
    expect(row.health_changed_at).not.toBeNull();

    const evs = await healthChangedEvents();
    expect(evs.length - before).toBe(1);
    expect(evs.at(-1)!.channel).toBe("notification.emitted");
    const payload = evs.at(-1)!.payload as { severity?: string; to_state?: string };
    expect(payload.severity).toBe("warn");
    expect(payload.to_state).toBe("degraded");

    const audits = await db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resource_id, c.id), eq(auditLog.action, "connector.health_changed")));
    expect(audits.length).toBe(1);

    const r2 = await setConnectorHealth(db.db, c, {
      state: "degraded",
      reason: "vendor 5xx streak",
      error_code: "vendor_degraded",
    });
    expect(r2.transitioned).toBe(false);
    expect((await healthChangedEvents()).length - before).toBe(1);
  });

  test("recovery to ok transitions but does NOT notify", async () => {
    const c = await seedHealthConnector("hs-recover");
    await setConnectorHealth(db.db, c, { state: "degraded", reason: "5xx" });
    const before = (await healthChangedEvents()).length;

    const r = await setConnectorHealth(db.db, c, { state: "ok", reason: "recovered" });
    expect(r.transitioned).toBe(true);
    expect((await connectorRow(c.id)).health_state).toBe("ok");
    expect((await healthChangedEvents()).length).toBe(before);
  });
});

describe("flagConnectorContractFailure", () => {
  test("removed endpoint flips to needs_update with severity error + successor URI", async () => {
    const c = await seedHealthConnector("hs-contract");
    const before = (await healthChangedEvents()).length;

    const r = await flagConnectorContractFailure(db.db, c, {
      error_code: "endpoint_removed",
      reason: "GET /rest/api/3/search returned 410 Gone",
      deprecation: {
        deprecated: "true",
        sunset: "Sat, 31 Jan 2026 23:59:59 GMT",
        successor_uri: "https://example.test/rest/api/3/search/jql",
      },
      workflow_id: null,
    });
    expect(r.transitioned).toBe(true);

    const row = await connectorRow(c.id);
    expect(row.health_state).toBe("needs_update");
    expect(row.health_error_code).toBe("endpoint_removed");
    expect(row.successor_uri).toBe("https://example.test/rest/api/3/search/jql");
    expect(row.sunset_at).not.toBeNull();

    const evs = await healthChangedEvents();
    expect(evs.length - before).toBe(1);
    const payload = evs.at(-1)!.payload as { severity?: string; successor_uri?: string };
    expect(payload.severity).toBe("error");
    expect(payload.successor_uri).toBe("https://example.test/rest/api/3/search/jql");

    const r2 = await flagConnectorContractFailure(db.db, c, {
      error_code: "endpoint_removed",
      reason: "GET /rest/api/3/search returned 410 Gone",
    });
    expect(r2.transitioned).toBe(false);
    expect((await healthChangedEvents()).length - before).toBe(1);
  });
});

describe("clearConnectorHealthOnSuccess", () => {
  test("clears degraded back to ok", async () => {
    const c = await seedHealthConnector("hs-clear-degraded");
    await setConnectorHealth(db.db, c, { state: "degraded", reason: "5xx" });
    await clearConnectorHealthOnSuccess(db.db, c);
    expect((await connectorRow(c.id)).health_state).toBe("ok");
  });

  test("does NOT clear needs_update — a removed endpoint stays broken", async () => {
    const c = await seedHealthConnector("hs-clear-update");
    await flagConnectorContractFailure(db.db, c, {
      error_code: "endpoint_removed",
      reason: "410",
    });
    await clearConnectorHealthOnSuccess(db.db, c);
    expect((await connectorRow(c.id)).health_state).toBe("needs_update");
  });
});

describe("setWorkflowHealth", () => {
  test("edge-guarded transition + audit", async () => {
    const [w] = await db.db
      .insert(workflows)
      .values({ tenant_id: tenantId, slug: "wf-health", name: "wf", lifecycle: "active" })
      .returning();
    const wf = { id: w!.id, tenant_id: tenantId };

    const r1 = await setWorkflowHealth(db.db, wf, {
      state: "needs_attention",
      reason: "connector jira needs_update",
    });
    expect(r1.transitioned).toBe(true);
    const r2 = await setWorkflowHealth(db.db, wf, {
      state: "needs_attention",
      reason: "connector jira needs_update",
    });
    expect(r2.transitioned).toBe(false);

    const rows = await db.db.select().from(workflows).where(eq(workflows.id, wf.id));
    expect(rows[0]!.health_state).toBe("needs_attention");

    const audits = await db.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.resource_id, wf.id), eq(auditLog.action, "workflow.health_changed")));
    expect(audits.length).toBe(1);
  });
});

describe("effectiveConnectorHealth", () => {
  test("precedence: needs_reauth > needs_update > degraded > ok", () => {
    expect(
      effectiveConnectorHealth({
        health_state: "ok",
        needs_reauth: false,
        circuit_state: "closed",
      }),
    ).toBe("ok");
    expect(
      effectiveConnectorHealth({ health_state: "ok", needs_reauth: true, circuit_state: "closed" }),
    ).toBe("needs_reauth");
    expect(
      effectiveConnectorHealth({
        health_state: "needs_update",
        needs_reauth: true,
        circuit_state: "closed",
      }),
    ).toBe("needs_reauth");
    expect(
      effectiveConnectorHealth({ health_state: "ok", needs_reauth: false, circuit_state: "open" }),
    ).toBe("degraded");
    expect(
      effectiveConnectorHealth({
        health_state: "needs_update",
        needs_reauth: false,
        circuit_state: "open",
      }),
    ).toBe("needs_update");
  });
});
