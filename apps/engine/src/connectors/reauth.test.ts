import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { connectors } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { seedConnector, seedTenant } from "../test-helpers/seed.ts";
import { buildReauthUrl, clearConnectorReauth, markConnectorNeedsReauth } from "./reauth.ts";

let db: TestDb;
let tenantId: string;
let otherTenantId: string;

beforeAll(async () => {
  db = await createTestDb("reauth-unit");

  tenantId = (await seedTenant(db.db, { slug: "t-reauth", display_name: "Reauth Tenant" })).id;
  otherTenantId = (
    await seedTenant(db.db, { slug: "t-reauth-other", display_name: "Other Tenant" })
  ).id;
});

afterAll(async () => {
  await db.cleanup();
});

async function seedReauthConnector(opts: {
  slug: string;
  tenantIdOverride?: string;
  authType?: string;
}): Promise<string> {
  const row = await seedConnector(db.db, {
    tenant_id: opts.tenantIdOverride ?? tenantId,
    slug: opts.slug,
    display_name: opts.slug,
    auth_type: (opts.authType ?? "bearer") as "bearer",
  });
  return row.id;
}

describe("markConnectorNeedsReauth", () => {
  test("first call on a healthy connector transitions to needs_reauth=true", async () => {
    const connectorId = await seedReauthConnector({ slug: "mark-first" });

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
    const connectorId = await seedReauthConnector({ slug: "mark-dedup" });

    await markConnectorNeedsReauth(db.db, tenantId, connectorId, "first_reason");

    const afterFirst = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    const firstAt = afterFirst[0]!.auth_failed_at;

    const { transitioned } = await markConnectorNeedsReauth(
      db.db,
      tenantId,
      connectorId,
      "second_reason",
    );

    expect(transitioned).toBe(false);

    const afterSecond = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(afterSecond[0]!.auth_failed_at?.toISOString()).toBe(firstAt?.toISOString());
    expect(afterSecond[0]!.auth_failed_reason).toBe("first_reason");
  });

  test("calling with a different tenant_id returns transitioned=false and leaves the row unmodified", async () => {
    const connectorId = await seedReauthConnector({ slug: "mark-tenant-isolation" });

    const { transitioned } = await markConnectorNeedsReauth(
      db.db,
      otherTenantId,
      connectorId,
      "cross_tenant_attack",
    );

    expect(transitioned).toBe(false);

    const rows = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(rows[0]!.needs_reauth).toBe(false);
    expect(rows[0]!.auth_failed_at).toBeNull();
    expect(rows[0]!.auth_failed_reason).toBeNull();
  });
});

describe("clearConnectorReauth", () => {
  test("clears needs_reauth + auth_failed_at + reason after a flag", async () => {
    const connectorId = await seedReauthConnector({ slug: "clear-after-flag" });

    await markConnectorNeedsReauth(db.db, tenantId, connectorId, "bad_token");

    await clearConnectorReauth(db.db, tenantId, connectorId);

    const rows = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    const row = rows[0]!;
    expect(row.needs_reauth).toBe(false);
    expect(row.auth_failed_at).toBeNull();
    expect(row.auth_failed_reason).toBeNull();
  });

  test("idempotent on an already-clear row (no error)", async () => {
    const connectorId = await seedReauthConnector({ slug: "clear-idempotent" });

    await expect(clearConnectorReauth(db.db, tenantId, connectorId)).resolves.toBeUndefined();

    const rows = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(rows[0]!.needs_reauth).toBe(false);
  });

  test("clear is tenant-scoped — different tenant cannot clear another tenant's flag", async () => {
    const connectorId = await seedReauthConnector({ slug: "clear-tenant-scope" });

    await markConnectorNeedsReauth(db.db, tenantId, connectorId, "original");

    await clearConnectorReauth(db.db, otherTenantId, connectorId);

    const rows = await db.db.select().from(connectors).where(eq(connectors.id, connectorId));
    expect(rows[0]!.needs_reauth).toBe(true);
  });
});

describe("buildReauthUrl", () => {
  test("basic auth connector without a public origin → method=portal_setup, reauth_url=null, instructions non-empty", async () => {
    const connectorId = await seedReauthConnector({ slug: "reauth-basic", authType: "basic" });

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
    expect(result.reauth_url).toBeNull();
  });

  test("bearer auth connector without a public origin → method=portal_setup", async () => {
    const connectorId = await seedReauthConnector({
      slug: "reauth-bearer-noorigin",
      authType: "bearer",
    });

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
    expect(typeof result.instructions).toBe("string");
    expect(result.instructions.length).toBeGreaterThan(0);
  });
});
