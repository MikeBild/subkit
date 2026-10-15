import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, connectors, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { registerTenantStateCache } from "../operator/tenant-state.ts";
import { now } from "../utils/clock.ts";
import {
  persistCircuitState,
  recordCircuitFailure,
  resetCircuitBreaker,
} from "./circuit-breaker.ts";
import {
  completeConnectorReauthorization,
  flagConnectorAuthFailure,
  settleConnectorReauthorization,
} from "./reauth.ts";

let testDb: TestDb;
let tenantId: string;
let otherTenantId: string;
let sequence = 0;
const invalidated: Array<string | undefined> = [];
registerTenantStateCache((tenant) => {
  invalidated.push(tenant);
});

beforeAll(async () => {
  testDb = await createTestDb("connector_reauthorization");
  const rows = await testDb.db
    .insert(tenants)
    .values([
      { slug: "t-reauthorization", display_name: "Reauthorization" },
      { slug: "t-reauthorization-other", display_name: "Another tenant" },
    ])
    .returning();
  if (!rows[0] || !rows[1]) throw new Error("seed tenants failed");
  tenantId = rows[0].id;
  otherTenantId = rows[1].id;
});

afterAll(async () => {
  await testDb.cleanup();
});

async function seedConnector(over: Partial<typeof connectors.$inferInsert> = {}) {
  sequence += 1;
  const [row] = await testDb.db
    .insert(connectors)
    .values({
      tenant_id: tenantId,
      slug: `example-mail-${sequence}`,
      display_name: "Example Mail",
      driver: "http",
      environment: "prod",
      auth_type: "oauth2",
      base_url: "https://mail.example.org",
      config: {},
      ...over,
    })
    .returning();
  if (!row) throw new Error("seed connector failed");
  return row;
}

async function read(id: string) {
  const [row] = await testDb.db.select().from(connectors).where(eq(connectors.id, id));
  if (!row) throw new Error("connector row missing");
  return row;
}

async function audit(id: string) {
  return testDb.db
    .select()
    .from(auditLog)
    .where(and(eq(auditLog.tenant_id, tenantId), eq(auditLog.resource_id, id)));
}

const OPEN = {
  circuit_state: "open",
  circuit_failure_count: 44,
  circuit_opened_at: new Date(now() - 90 * 86_400_000),
} as const;

describe("the breaker's persistence", () => {
  test("closing clears the stamp of the trip it recovered from", async () => {
    const connector = await seedConnector(OPEN);
    await persistCircuitState(testDb.db, connector, {
      circuit_state: "closed",
      circuit_failure_count: 0,
    });
    const row = await read(connector.id);
    expect(row.circuit_state).toBe("closed");
    expect(row.circuit_failure_count).toBe(0);
    expect(row.circuit_opened_at).toBeNull();
  });

  test("half-open keeps it: that is still the trip the probe is testing", async () => {
    const connector = await seedConnector(OPEN);
    await persistCircuitState(testDb.db, connector, { circuit_state: "half-open" });
    const row = await read(connector.id);
    expect(row.circuit_state).toBe("half-open");
    expect(row.circuit_opened_at?.getTime()).toBe(OPEN.circuit_opened_at.getTime());
  });

  test("a trip after a close is stamped afresh", async () => {
    const connector = await seedConnector({ circuit_threshold: 1 });
    await recordCircuitFailure(testDb.db, connector);
    const tripped = await read(connector.id);
    expect(tripped.circuit_state).toBe("open");
    expect(tripped.circuit_opened_at).not.toBeNull();
    await persistCircuitState(testDb.db, connector, {
      circuit_state: "closed",
      circuit_failure_count: 0,
    });
    expect((await read(connector.id)).circuit_opened_at).toBeNull();
  });

  test("a write names its tenant: another tenant's id changes nothing", async () => {
    const connector = await seedConnector(OPEN);
    const foreign = { id: connector.id, tenant_id: otherTenantId };
    await persistCircuitState(testDb.db, foreign, {
      circuit_state: "closed",
      circuit_failure_count: 0,
    });
    await recordCircuitFailure(testDb.db, foreign);
    expect(await resetCircuitBreaker(testDb.db, otherTenantId, connector.id)).toBeNull();
    const row = await read(connector.id);
    expect(row.circuit_state).toBe("open");
    expect(row.circuit_failure_count).toBe(44);
  });

  test("a reset reports what it replaced, and nothing when there was nothing to reset", async () => {
    const connector = await seedConnector(OPEN);
    expect(await resetCircuitBreaker(testDb.db, tenantId, connector.id)).toEqual({
      circuit_state: "open",
      circuit_failure_count: 44,
    });
    expect(await resetCircuitBreaker(testDb.db, tenantId, connector.id)).toBeNull();
  });

  test("a closed breaker that still carries a stamp or a count is reset too", async () => {
    const stamped = await seedConnector({
      circuit_state: "closed",
      circuit_opened_at: OPEN.circuit_opened_at,
    });
    expect(await resetCircuitBreaker(testDb.db, tenantId, stamped.id)).not.toBeNull();
    expect((await read(stamped.id)).circuit_opened_at).toBeNull();

    const counting = await seedConnector({ circuit_state: "closed", circuit_failure_count: 3 });
    expect(await resetCircuitBreaker(testDb.db, tenantId, counting.id)).toEqual({
      circuit_state: "closed",
      circuit_failure_count: 3,
    });
    expect((await read(counting.id)).circuit_failure_count).toBe(0);
  });
});

describe("completeConnectorReauthorization", () => {
  test("clears the flag, its mirror and the breaker — each with its own audit row", async () => {
    const connector = await seedConnector({
      ...OPEN,
      needs_reauth: true,
      auth_failed_at: OPEN.circuit_opened_at,
      auth_failed_reason: "credential rejected",
      health_state: "needs_reauth",
      health_reason: "credential rejected",
    });

    await completeConnectorReauthorization(testDb.db, {
      tenant_id: tenantId,
      connector_id: connector.id,
    });

    const row = await read(connector.id);
    expect(row.needs_reauth).toBe(false);
    expect(row.auth_failed_at).toBeNull();
    expect(row.auth_failed_reason).toBeNull();
    expect(row.health_state).toBe("ok");
    expect(row.circuit_state).toBe("closed");
    expect(row.circuit_failure_count).toBe(0);
    expect(row.circuit_opened_at).toBeNull();

    const rows = await audit(connector.id);
    const reset = rows.find((entry) => entry.action === "connector.circuit_reset");
    expect(rows.map((entry) => entry.action).sort()).toEqual([
      "connector.circuit_reset",
      "connector.health_changed",
      "connector.reauth_cleared",
    ]);
    expect(reset?.actor_type).toBe("system");
    expect(reset?.reason).toBe("reauthorized");
    expect(reset?.metadata).toEqual({ from_state: "open", failure_count: 44 });
  });

  test("does not switch a disabled connector on", async () => {
    const connector = await seedConnector({ ...OPEN, enabled: false, needs_reauth: true });
    await completeConnectorReauthorization(testDb.db, {
      tenant_id: tenantId,
      connector_id: connector.id,
    });
    const row = await read(connector.id);
    expect(row.enabled).toBe(false);
    expect(row.needs_reauth).toBe(false);
    expect(row.circuit_state).toBe("closed");
  });

  test("leaves a verdict that signing in cannot fix", async () => {
    const connector = await seedConnector({
      needs_reauth: true,
      health_state: "needs_update",
      health_error_code: "endpoint_removed",
    });
    await completeConnectorReauthorization(testDb.db, {
      tenant_id: tenantId,
      connector_id: connector.id,
    });
    const row = await read(connector.id);
    expect(row.needs_reauth).toBe(false);
    expect(row.health_state).toBe("needs_update");
  });

  test("a connector with nothing to resolve writes no audit row", async () => {
    const connector = await seedConnector();
    await completeConnectorReauthorization(testDb.db, {
      tenant_id: tenantId,
      connector_id: connector.id,
    });
    expect(await audit(connector.id)).toEqual([]);
  });

  test("the rows name the person when there is one", async () => {
    const connector = await seedConnector({ ...OPEN, needs_reauth: true });
    const actor_id = connector.id;
    await completeConnectorReauthorization(testDb.db, {
      tenant_id: tenantId,
      connector_id: connector.id,
      actor: { kind: "user", id: actor_id },
    });
    for (const entry of await audit(connector.id)) {
      expect(entry.actor_type).toBe("user");
      expect(entry.actor_id).toBe(actor_id);
    }
  });

  test("an untyped identifier does not establish a person", async () => {
    const connector = await seedConnector({ ...OPEN, needs_reauth: true });
    await completeConnectorReauthorization(testDb.db, {
      tenant_id: tenantId,
      connector_id: connector.id,
      actor_id: connector.id,
    });
    const entries = await audit(connector.id);
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.actor_type).toBe("unknown");
      expect(entry.actor_id).toBeNull();
    }
  });

  test("another tenant's call resolves nothing", async () => {
    const connector = await seedConnector({ ...OPEN, needs_reauth: true });
    await completeConnectorReauthorization(testDb.db, {
      tenant_id: otherTenantId,
      connector_id: connector.id,
    });
    const row = await read(connector.id);
    expect(row.needs_reauth).toBe(true);
    expect(row.circuit_state).toBe("open");
  });
});

describe("the tenant's cached views", () => {
  test("are dropped when a connector starts or stops needing a sign-in", async () => {
    const connector = await seedConnector();
    const flagged = {
      id: connector.id,
      tenant_id: tenantId,
      slug: connector.slug,
      driver: "http" as const,
      auth_type: "oauth2" as const,
      config: {},
      template_snapshot: null,
    };
    invalidated.length = 0;
    await flagConnectorAuthFailure(testDb.db, flagged, { reason: "credential rejected" });
    expect(invalidated).toEqual([tenantId]);
    await flagConnectorAuthFailure(testDb.db, flagged, { reason: "credential rejected" });
    expect(invalidated).toEqual([tenantId]);

    await completeConnectorReauthorization(testDb.db, {
      tenant_id: tenantId,
      connector_id: connector.id,
    });
    expect(invalidated).toEqual([tenantId, tenantId]);
    await completeConnectorReauthorization(testDb.db, {
      tenant_id: tenantId,
      connector_id: connector.id,
    });
    expect(invalidated).toEqual([tenantId, tenantId]);
  });

  test("are dropped when only the breaker was reset", async () => {
    const connector = await seedConnector(OPEN);
    invalidated.length = 0;
    await completeConnectorReauthorization(testDb.db, {
      tenant_id: tenantId,
      connector_id: connector.id,
    });
    expect(invalidated).toEqual([tenantId]);
  });
});

describe("settleConnectorReauthorization", () => {
  test("resolves like the funnel, and never rejects", async () => {
    const connector = await seedConnector({ ...OPEN, needs_reauth: true });
    await settleConnectorReauthorization(testDb.db, {
      tenant_id: tenantId,
      connector_id: connector.id,
    });
    expect((await read(connector.id)).needs_reauth).toBe(false);
    const broken = {
      execute: () => Promise.reject(new Error("connection refused")),
    } as unknown as typeof testDb.db;
    await expect(
      settleConnectorReauthorization(broken, { tenant_id: tenantId, connector_id: connector.id }),
    ).resolves.toBeUndefined();
  });
});
