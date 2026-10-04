import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, connectors, credentials, events, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import {
  deleteCredential,
  getCredentialForConnector,
  rotateOAuth2Tokens,
  upsertCredential,
} from "../service.ts";

const TEST_NOW_MS = getTestNow();

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("credentials_svc");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedTenantAndConnector(): Promise<{ tenant_id: string; connector_id: string }> {
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: `t-${Math.random().toString(36).slice(2, 8)}`, display_name: "T" }) // allow-random: legacy; review before changing
    .returning();
  const [conn] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id: tenant!.id,
      slug: `c-${Math.random().toString(36).slice(2, 8)}`, // allow-random: legacy; review before changing
      display_name: "C",
      driver: "http",
      environment: "dev",
      auth_type: "bearer",
      base_url: "https://example.test",
    })
    .returning();
  return { tenant_id: tenant!.id, connector_id: conn!.id };
}

describe("credentials/service", () => {
  test("encrypt + decrypt bearer credential", async () => {
    const { tenant_id, connector_id } = await seedTenantAndConnector();
    const row = await upsertCredential(
      {
        tenant_id,
        connector_id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "sk-secret-123" },
        actor_id: null,
      },
      ctx.db,
    );
    expect(row.id).toBeDefined();

    const dbRows = await ctx.db.select().from(credentials).where(eq(credentials.id, row.id));
    const dbRow = dbRows[0]!;
    const hex = Buffer.from(dbRow.ciphertext).toString("hex");
    const plainHex = Buffer.from("sk-secret-123", "utf8").toString("hex");
    expect(hex.includes(plainHex)).toBe(false);

    const fetched = await getCredentialForConnector(tenant_id, connector_id, "dev", ctx.db);
    expect(fetched).not.toBeNull();
    expect(fetched!.value.mode).toBe("bearer");
    if (fetched!.value.mode === "bearer") {
      expect(fetched!.value.token).toBe("sk-secret-123");
    }

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.resource_id, row.id)));
    const actions = audits.map((a) => a.action);
    expect(actions).toContain("credential.created");
  });

  test("rotate oauth2 tokens writes audit and new ciphertext", async () => {
    const { tenant_id, connector_id } = await seedTenantAndConnector();
    const created = await upsertCredential(
      {
        tenant_id,
        connector_id,
        environment: "dev",
        mode: "oauth2",
        value: {
          mode: "oauth2",
          access_token: "access-1",
          token_type: "Bearer",
        },
        oauth2_refresh_token: "refresh-1",
        oauth2_expires_at: new Date(TEST_NOW_MS + 60_000),
        actor_id: null,
      },
      ctx.db,
    );

    await rotateOAuth2Tokens(
      {
        tenant_id,
        credential_id: created.id,
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_at: new Date(TEST_NOW_MS + 90_000),
        actor_id: null,
      },
      ctx.db,
    );

    const fetched = await getCredentialForConnector(tenant_id, connector_id, "dev", ctx.db);
    expect(fetched).not.toBeNull();
    if (fetched!.value.mode === "oauth2") {
      expect(fetched!.value.access_token).toBe("access-2");
      expect(fetched!.value.refresh_token).toBe("refresh-2");
    }

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.resource_id, created.id)));
    expect(audits.map((a) => a.action)).toContain("credential.rotated");
  });

  test("delete removes row and writes audit", async () => {
    const { tenant_id, connector_id } = await seedTenantAndConnector();
    const created = await upsertCredential(
      {
        tenant_id,
        connector_id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "to-be-deleted" },
        actor_id: null,
      },
      ctx.db,
    );
    await deleteCredential(tenant_id, created.id, null, ctx.db);
    const remaining = await ctx.db.select().from(credentials).where(eq(credentials.id, created.id));
    expect(remaining.length).toBe(0);
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.resource_id, created.id)));
    expect(audits.map((a) => a.action)).toContain("credential.deleted");
  });

  test("storing and deleting a credential reach the live feed as the connector id only", async () => {
    const { tenant_id, connector_id } = await seedTenantAndConnector();
    const created = await upsertCredential(
      {
        tenant_id,
        connector_id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "never-in-an-event" },
        actor_id: null,
      },
      ctx.db,
    );
    await deleteCredential(tenant_id, created.id, null, ctx.db);
    const rows = await ctx.db
      .select({ type: events.type, payload: events.payload })
      .from(events)
      .where(and(eq(events.tenant_id, tenant_id), eq(events.channel, "resource.lifecycle")))
      .orderBy(events.id);
    expect(rows).toEqual([
      { type: "connector.credential_changed", payload: { connector_id } },
      { type: "connector.credential_changed", payload: { connector_id } },
    ]);
  });
});
