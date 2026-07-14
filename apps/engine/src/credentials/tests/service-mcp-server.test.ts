// Coverage for the external-MCP-server-owned credential accessors:
// getCredentialForMcpServer, getOAuth2ClientCredentialForMcpServer,
// getOAuth2PrivateKeyCredentialForMcpServer. These mirror the
// connector-owned accessors (getCredentialForConnector /
// getOAuth2ClientCredential) but key off mcp_server_id — service.test.ts
// only exercises the connector-owned path, so these were unexercised.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, mcpServers, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import {
  getCredentialForMcpServer,
  getOAuth2ClientCredentialForMcpServer,
  getOAuth2PrivateKeyCredentialForMcpServer,
  upsertCredential,
} from "../service.ts";

const TEST_NOW_MS = getTestNow();

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("credentials_svc_mcp_server");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedTenant(): Promise<string> {
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: `t-${Math.random().toString(36).slice(2, 8)}`, display_name: "T" }) // allow-random: test fixture
    .returning();
  return tenant!.id;
}

async function seedMcpServer(tenant_id: string): Promise<string> {
  const [server] = await ctx.db
    .insert(mcpServers)
    .values({
      tenant_id,
      name: "External MCP",
      namespace: `mcp-${Math.random().toString(36).slice(2, 8)}`, // allow-random: test fixture
      transport: "http",
      url: "https://mcp.example.test/mcp",
    })
    .returning();
  return server!.id;
}

describe("credentials/service — mcp-server-owned credentials", () => {
  test("getCredentialForMcpServer: round trips a bearer credential and writes audit", async () => {
    const tenant_id = await seedTenant();
    const mcp_server_id = await seedMcpServer(tenant_id);
    const row = await upsertCredential(
      {
        tenant_id,
        mcp_server_id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "mcp-bearer-token" },
        actor_id: null,
      },
      ctx.db,
    );
    expect(row.mcp_server_id).toBe(mcp_server_id);
    expect(row.connector_id).toBeNull();

    const fetched = await getCredentialForMcpServer(tenant_id, mcp_server_id, "dev", ctx.db);
    expect(fetched).not.toBeNull();
    expect(fetched!.value.mode).toBe("bearer");
    if (fetched!.value.mode === "bearer") {
      expect(fetched!.value.token).toBe("mcp-bearer-token");
    }

    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.resource_id, row.id)));
    expect(audits.map((a) => a.action)).toContain("credential.created");
  });

  test("getCredentialForMcpServer: oauth2 mode carries the refresh token + expiry", async () => {
    const tenant_id = await seedTenant();
    const mcp_server_id = await seedMcpServer(tenant_id);
    await upsertCredential(
      {
        tenant_id,
        mcp_server_id,
        environment: "dev",
        mode: "oauth2",
        value: { mode: "oauth2", access_token: "mcp-access-1", token_type: "Bearer" },
        oauth2_refresh_token: "mcp-refresh-1",
        oauth2_expires_at: new Date(TEST_NOW_MS + 60_000),
        actor_id: null,
      },
      ctx.db,
    );

    const fetched = await getCredentialForMcpServer(tenant_id, mcp_server_id, "dev", ctx.db);
    expect(fetched).not.toBeNull();
    expect(fetched!.value.mode).toBe("oauth2");
    if (fetched!.value.mode === "oauth2") {
      expect(fetched!.value.access_token).toBe("mcp-access-1");
      expect(fetched!.value.refresh_token).toBe("mcp-refresh-1");
      expect(fetched!.value.expires_at?.getTime()).toBe(TEST_NOW_MS + 60_000);
    }
  });

  test("getCredentialForMcpServer: oauth2 with no refresh token still surfaces expires_at (client_credentials_json-style grant)", async () => {
    const tenant_id = await seedTenant();
    const mcp_server_id = await seedMcpServer(tenant_id);
    await upsertCredential(
      {
        tenant_id,
        mcp_server_id,
        environment: "dev",
        mode: "oauth2",
        value: { mode: "oauth2", access_token: "mcp-remint-1", token_type: "Bearer" },
        oauth2_refresh_token: null,
        oauth2_expires_at: new Date(TEST_NOW_MS + 30_000),
        actor_id: null,
      },
      ctx.db,
    );

    const fetched = await getCredentialForMcpServer(tenant_id, mcp_server_id, "dev", ctx.db);
    expect(fetched).not.toBeNull();
    if (fetched!.value.mode === "oauth2") {
      expect(fetched!.value.refresh_token).toBeNull();
      expect(fetched!.value.expires_at?.getTime()).toBe(TEST_NOW_MS + 30_000);
    }
  });

  test("getCredentialForMcpServer: draft (non-UUID) id short-circuits to null", async () => {
    const tenant_id = await seedTenant();
    const fetched = await getCredentialForMcpServer(tenant_id, "draft-not-a-uuid", "dev", ctx.db);
    expect(fetched).toBeNull();
  });

  test("getCredentialForMcpServer: wrong tenant sees nothing (tenant isolation)", async () => {
    const owner_tenant_id = await seedTenant();
    const other_tenant_id = await seedTenant();
    const mcp_server_id = await seedMcpServer(owner_tenant_id);
    await upsertCredential(
      {
        tenant_id: owner_tenant_id,
        mcp_server_id,
        environment: "dev",
        mode: "bearer",
        value: { mode: "bearer", token: "owner-only-token" },
        actor_id: null,
      },
      ctx.db,
    );

    const fetched = await getCredentialForMcpServer(other_tenant_id, mcp_server_id, "dev", ctx.db);
    expect(fetched).toBeNull();
  });

  test("getOAuth2ClientCredentialForMcpServer: round trips the RFC 7591 client identity", async () => {
    const tenant_id = await seedTenant();
    const mcp_server_id = await seedMcpServer(tenant_id);
    await upsertCredential(
      {
        tenant_id,
        mcp_server_id,
        environment: "dev",
        mode: "oauth2_client",
        value: {
          mode: "oauth2_client",
          client_id: "dynamically-registered-client",
          client_secret: "dcr-secret",
        },
        actor_id: null,
      },
      ctx.db,
    );

    const client = await getOAuth2ClientCredentialForMcpServer(
      tenant_id,
      mcp_server_id,
      "dev",
      ctx.db,
    );
    expect(client).not.toBeNull();
    expect(client!.client_id).toBe("dynamically-registered-client");
    expect(client!.client_secret).toBe("dcr-secret");
  });

  test("getOAuth2ClientCredentialForMcpServer: returns null when no registration slot exists", async () => {
    const tenant_id = await seedTenant();
    const mcp_server_id = await seedMcpServer(tenant_id);
    const client = await getOAuth2ClientCredentialForMcpServer(
      tenant_id,
      mcp_server_id,
      "dev",
      ctx.db,
    );
    expect(client).toBeNull();
  });

  test("getOAuth2ClientCredentialForMcpServer: draft (non-UUID) id short-circuits to null", async () => {
    const tenant_id = await seedTenant();
    const client = await getOAuth2ClientCredentialForMcpServer(
      tenant_id,
      "draft-not-a-uuid",
      "dev",
      ctx.db,
    );
    expect(client).toBeNull();
  });

  test("getOAuth2PrivateKeyCredentialForMcpServer: round trips client_id + private_key + algorithm", async () => {
    const tenant_id = await seedTenant();
    const mcp_server_id = await seedMcpServer(tenant_id);
    await upsertCredential(
      {
        tenant_id,
        mcp_server_id,
        environment: "dev",
        mode: "oauth2_private_key",
        value: {
          mode: "oauth2_private_key",
          client_id: "m2m-client",
          private_key: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
          algorithm: "RS256",
        },
        actor_id: null,
      },
      ctx.db,
    );

    const key = await getOAuth2PrivateKeyCredentialForMcpServer(
      tenant_id,
      mcp_server_id,
      "dev",
      ctx.db,
    );
    expect(key).not.toBeNull();
    expect(key!.client_id).toBe("m2m-client");
    expect(key!.algorithm).toBe("RS256");
    expect(key!.private_key).toContain("BEGIN PRIVATE KEY");
  });

  test("getOAuth2PrivateKeyCredentialForMcpServer: returns null when no private-key credential exists", async () => {
    const tenant_id = await seedTenant();
    const mcp_server_id = await seedMcpServer(tenant_id);
    const key = await getOAuth2PrivateKeyCredentialForMcpServer(
      tenant_id,
      mcp_server_id,
      "dev",
      ctx.db,
    );
    expect(key).toBeNull();
  });

  test("getOAuth2PrivateKeyCredentialForMcpServer: draft (non-UUID) id short-circuits to null", async () => {
    const tenant_id = await seedTenant();
    const key = await getOAuth2PrivateKeyCredentialForMcpServer(
      tenant_id,
      "draft-not-a-uuid",
      "dev",
      ctx.db,
    );
    expect(key).toBeNull();
  });
});
