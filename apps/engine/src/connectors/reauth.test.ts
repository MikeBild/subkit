// Unit tests for the connector re-auth state machine.
//
// Covers: markConnectorNeedsReauth (first-call transition, dedup guard,
// tenant isolation), clearConnectorReauth (idempotency), and
// buildReauthUrl (basic/bearer → portal_setup, no public origin → null url).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connectors, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { buildReauthUrl, clearConnectorReauth, markConnectorNeedsReauth } from "./reauth.ts";

let db: TestDb;
let tenantId: string;
let otherTenantId: string;

beforeAll(async () => {
  db = await createTestDb("reauth-unit");

  const [t] = await db.db
    .insert(tenants)
    .values({ slug: "t-reauth", display_name: "Reauth Tenant" })
    .returning();
  tenantId = t!.id;

  const [t2] = await db.db
    .insert(tenants)
    .values({ slug: "t-reauth-other", display_name: "Other Tenant" })
    .returning();
  otherTenantId = t2!.id;
});

afterAll(async () => {
  await db.cleanup();
});

async function seedConnector(opts: {
  slug: string;
  tenantIdOverride?: string;
  authType?: string;
}): Promise<string> {
  const [c] = await db.db
    .insert(connectors)
    .values({
      tenant_id: opts.tenantIdOverride ?? tenantId,
      slug: opts.slug,
      display_name: opts.slug,
      driver: "http",
      environment: "dev",
      auth_type: (opts.authType ?? "bearer") as "bearer",
      base_url: "https://example.test",
      config: {},
    })
    .returning();
  return c!.id;
}

// ---------------------------------------------------------------------------
// markConnectorNeedsReauth
// ---------------------------------------------------------------------------

describe("markConnectorNeedsReauth", () => {
  test("first call on a healthy connector transitions to needs_reauth=true", async () => {
    const connectorId = await seedConnector({ slug: "mark-first" });

    const { transitioned } = await markConnectorNeedsReauth(
      db.db,
      tenantId,
      connectorId,
      "credential_revoked",
    );

    expect(transitioned).toBe(true);

    const rows = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    const row = rows[0]!;
    expect(row.needs_reauth).toBe(true);
    expect(row.auth_failed_at).not.toBeNull();
    expect(row.auth_failed_reason).toBe("credential_revoked");
  });

  test("second call on an already-flagged connector returns transitioned=false and does not update auth_failed_at", async () => {
    const connectorId = await seedConnector({ slug: "mark-dedup" });

    await markConnectorNeedsReauth(db.db, tenantId, connectorId, "first_reason");

    const afterFirst = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    const firstAt = afterFirst[0]!.auth_failed_at;

    // No time delay needed: the dedup guard means the second UPDATE matches no
    // row (WHERE needs_reauth = false), so auth_failed_at cannot change.
    const { transitioned } = await markConnectorNeedsReauth(
      db.db,
      tenantId,
      connectorId,
      "second_reason",
    );

    expect(transitioned).toBe(false);

    const afterSecond = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    // auth_failed_at must be unchanged (dedup guard held).
    expect(afterSecond[0]!.auth_failed_at?.toISOString()).toBe(firstAt?.toISOString());
    // reason must NOT have been overwritten.
    expect(afterSecond[0]!.auth_failed_reason).toBe("first_reason");
  });

  test("calling with a different tenant_id returns transitioned=false and leaves the row unmodified", async () => {
    const connectorId = await seedConnector({ slug: "mark-tenant-isolation" });

    // Attempt to mark using the OTHER tenant's id — must be rejected.
    const { transitioned } = await markConnectorNeedsReauth(
      db.db,
      otherTenantId,
      connectorId,
      "cross_tenant_attack",
    );

    expect(transitioned).toBe(false);

    const rows = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    // Row is still healthy.
    expect(rows[0]!.needs_reauth).toBe(false);
    expect(rows[0]!.auth_failed_at).toBeNull();
    expect(rows[0]!.auth_failed_reason).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// clearConnectorReauth
// ---------------------------------------------------------------------------

describe("clearConnectorReauth", () => {
  test("clears needs_reauth + auth_failed_at + reason after a flag", async () => {
    const connectorId = await seedConnector({ slug: "clear-after-flag" });

    await markConnectorNeedsReauth(db.db, tenantId, connectorId, "bad_token");

    await clearConnectorReauth(db.db, tenantId, connectorId);

    const rows = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    const row = rows[0]!;
    expect(row.needs_reauth).toBe(false);
    expect(row.auth_failed_at).toBeNull();
    expect(row.auth_failed_reason).toBeNull();
  });

  test("idempotent on an already-clear row (no error)", async () => {
    const connectorId = await seedConnector({ slug: "clear-idempotent" });

    // Row was never flagged — clear must succeed silently.
    await expect(clearConnectorReauth(db.db, tenantId, connectorId)).resolves.toBeUndefined();

    const rows = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(rows[0]!.needs_reauth).toBe(false);
  });

  test("clear is tenant-scoped — different tenant cannot clear another tenant's flag", async () => {
    const connectorId = await seedConnector({ slug: "clear-tenant-scope" });

    await markConnectorNeedsReauth(db.db, tenantId, connectorId, "original");

    // Clear with wrong tenant — should update no rows but not throw.
    await clearConnectorReauth(db.db, otherTenantId, connectorId);

    const rows = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    // Flag remains set because the WHERE tenant_id filtered it out.
    expect(rows[0]!.needs_reauth).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// buildReauthUrl
// ---------------------------------------------------------------------------

describe("buildReauthUrl", () => {
  test("basic auth connector without a public origin → method=portal_setup, reauth_url=null, instructions non-empty", async () => {
    // Remove any public base url so buildOAuthRedirectUri() returns null.
    // The env var is not set in tests, so redirect_uri will be null by default.
    const connectorId = await seedConnector({ slug: "reauth-basic", authType: "basic" });

    const rows = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    const row = rows[0]!;

    const connectorView = {
      id: row.id,
      tenant_id: row.tenant_id,
      slug: row.slug,
      display_name: row.display_name,
      driver: "http" as const,
      environment: row.environment as "dev",
      auth_type: "basic" as const,
      base_url: row.base_url ?? null,
      dsn: row.dsn ?? null,
      config: (row.config as Record<string, unknown>) ?? {},
      operator_quirks: {} as Record<string, string>,
      template_slug: null,
      template_name: null,
      template_source: null,
      template_version: null,
      template_snapshot: null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      circuit_state: "closed" as const,
      circuit_opened_at: null,
      circuit_failure_count: 0,
      circuit_threshold: 5,
      circuit_reset_ms: 300000,
      needs_reauth: false,
      auth_failed_at: null,
      auth_failed_reason: null,
    };

    const result = buildReauthUrl(connectorView);

    expect(result.method).toBe("portal_setup");
    expect(typeof result.instructions).toBe("string");
    expect(result.instructions.length).toBeGreaterThan(0);
    // Without a public origin configured in the test env, reauth_url is null.
    expect(result.reauth_url).toBeNull();
  });

  test("bearer auth connector without a public origin → method=portal_setup", async () => {
    const connectorId = await seedConnector({ slug: "reauth-bearer-noorigin", authType: "bearer" });

    const rows = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    const row = rows[0]!;

    const connectorView = {
      id: row.id,
      tenant_id: row.tenant_id,
      slug: row.slug,
      display_name: row.display_name,
      driver: "http" as const,
      environment: row.environment as "dev",
      auth_type: "bearer" as const,
      base_url: row.base_url ?? null,
      dsn: row.dsn ?? null,
      config: (row.config as Record<string, unknown>) ?? {},
      operator_quirks: {} as Record<string, string>,
      template_slug: null,
      template_name: null,
      template_source: null,
      template_version: null,
      template_snapshot: null,
      created_at: row.created_at,
      updated_at: row.updated_at,
      circuit_state: "closed" as const,
      circuit_opened_at: null,
      circuit_failure_count: 0,
      circuit_threshold: 5,
      circuit_reset_ms: 300000,
      needs_reauth: false,
      auth_failed_at: null,
      auth_failed_reason: null,
    };

    const result = buildReauthUrl(connectorView);

    expect(result.method).toBe("portal_setup");
    // Instructions must always be present so the operator knows what to do.
    expect(typeof result.instructions).toBe("string");
    expect(result.instructions.length).toBeGreaterThan(0);
  });
});
