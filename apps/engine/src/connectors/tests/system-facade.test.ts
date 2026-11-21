import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { getCredentialAuthorityMetadata } from "../../credentials/authority-metadata.ts";
import { secretNames } from "../../credentials/connections/service.ts";
import {
  connectors,
  outboundConnections,
  runtimeSecretVersions,
  vaultItems,
} from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { createConnector } from "../service.ts";
import { connectorSystemKey, loadConnectorSystem, loadConnectorSystems } from "../system.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("connectors_facade");
});

afterAll(async () => {
  await ctx.cleanup();
});

describe("ConnectorSystem facade", () => {
  test("loadConnectorSystem returns null for unknown connector", async () => {
    const tenant_id = (await seedTenant(ctx.db)).id;
    const sys = await loadConnectorSystem(
      tenant_id,
      "00000000-0000-0000-0000-000000000000",
      "dev",
      ctx.db,
    );
    expect(sys).toBeNull();
  });

  test("facade exposes connector + driver + tenant identity", async () => {
    const tenant_id = (await seedTenant(ctx.db)).id;
    const created = await createConnector(
      {
        tenant_id,
        input: {
          name: "Facade Probe",
          driver: "http",
          environment: "dev",
          base_url: "https://facade.example.test",
          auth_type: "bearer",
          config: {},
        },
        actor_id: null,
      },
      ctx.db,
    );

    const sys = await loadConnectorSystem(tenant_id, created.id, "dev", ctx.db);
    expect(sys).not.toBeNull();
    expect(sys!.id).toBe(created.id);
    expect(sys!.tenantId).toBe(tenant_id);
    expect(sys!.driver).toBe("http");
    expect(sys!.environment).toBe("dev");
    expect(sys!.connector.slug).toBe("facade-probe");
  });

  test("getCredentials returns null when none configured (probe path)", async () => {
    const tenant_id = (await seedTenant(ctx.db)).id;
    const created = await createConnector(
      {
        tenant_id,
        input: {
          name: "No Creds",
          driver: "http",
          environment: "dev",
          base_url: "https://nocreds.example.test",
          auth_type: "none",
          config: {},
        },
        actor_id: null,
      },
      ctx.db,
    );

    const sys = await loadConnectorSystem(tenant_id, created.id, "dev", ctx.db);
    const creds = await sys!.getCredentials();
    expect(creds).toBeNull();
  });

  test("getDocumentation returns [] when no docs ingested", async () => {
    const tenant_id = (await seedTenant(ctx.db)).id;
    const created = await createConnector(
      {
        tenant_id,
        input: {
          name: "No Docs",
          driver: "http",
          environment: "dev",
          base_url: "https://nodocs.example.test",
          auth_type: "none",
          config: {},
        },
        actor_id: null,
      },
      ctx.db,
    );

    const sys = await loadConnectorSystem(tenant_id, created.id, "dev", ctx.db);
    const docs = await sys!.getDocumentation();
    expect(docs).toEqual([]);
  });

  test("environment fallback resolves to base connector when no sibling exists", async () => {
    const tenant_id = (await seedTenant(ctx.db)).id;
    const created = await createConnector(
      {
        tenant_id,
        input: {
          name: "Dev Only",
          driver: "http",
          environment: "dev",
          base_url: "https://dev-only.example.test",
          auth_type: "none",
          config: {},
        },
        actor_id: null,
      },
      ctx.db,
    );

    const sys = await loadConnectorSystem(tenant_id, created.id, "prod", ctx.db);
    expect(sys).not.toBeNull();
    expect(sys!.id).toBe(created.id);
    expect(sys!.environment).toBe("dev");
  });
});

async function batchConnector(tenant_id: string, slug: string, environment: "dev" | "prod") {
  const [row] = await ctx.db
    .insert(connectors)
    .values({
      tenant_id,
      slug,
      display_name: slug,
      environment,
      driver: "http",
      auth_type: "oauth2",
      base_url: `https://${environment}.example.test`,
    })
    .returning();
  if (!row) throw new Error("missing batch connector fixture");
  return row;
}

async function batchCredential(
  connector: typeof connectors.$inferSelect,
  mode: "oauth2" | "oauth2_client" | "bearer",
  revision: number,
  created_at: Date,
) {
  const [row] = await ctx.db
    .insert(vaultItems)
    .values({
      tenant_id: connector.tenant_id,
      connector_id: connector.id,
      environment: connector.environment,
      mode,
      authority_revision: revision,
      created_at,
      ciphertext: Buffer.from("not encrypted"),
      iv: Buffer.from("not an iv"),
      auth_tag: Buffer.from("not a tag"),
      granted_scopes: "write read read",
      oauth2_expires_at: null,
    })
    .returning();
  if (!row) throw new Error("missing batch credential fixture");
  return row;
}

test("batch facade retains environment fallback and excludes foreign and deleted bases", async () => {
  const tenant_id = (await seedTenant(ctx.db)).id;
  const foreignTenant = (await seedTenant(ctx.db)).id;
  const dev = await batchConnector(tenant_id, "paired", "dev");
  const prod = await batchConnector(tenant_id, "paired", "prod");
  const fallback = await batchConnector(tenant_id, "fallback", "dev");
  const foreign = await batchConnector(foreignTenant, "fallback", "prod");
  const deleted = await batchConnector(tenant_id, "removed", "dev");
  await ctx.db
    .update(connectors)
    .set({ deleted_at: new Date(1) })
    .where(and(eq(connectors.tenant_id, tenant_id), eq(connectors.id, deleted.id)));
  const devCredential = await batchCredential(dev, "bearer", 2, new Date(1));
  const prodCredential = await batchCredential(prod, "bearer", 3, new Date(1));
  const requests = [dev, fallback, foreign, deleted].map((row) => ({
    connector_id: row.id,
    environment: "prod" as const,
  }));
  const systems = await loadConnectorSystems(tenant_id, requests, ctx.db);
  const switched = systems.get(connectorSystemKey(dev.id, "prod"));
  expect(switched?.id).toBe(prod.id);
  expect(switched?.environment).toBe("prod");
  expect((await switched?.getAuthorityMetadata())?.binding.primary?.id).toBe(prodCredential.id);
  expect((await switched?.getAuthorityMetadata())?.binding.primary?.id).not.toBe(devCredential.id);
  expect(systems.get(connectorSystemKey(fallback.id, "prod"))?.environment).toBe("dev");
  expect(systems.get(connectorSystemKey(foreign.id, "prod"))).toBeNull();
  expect(systems.get(connectorSystemKey(deleted.id, "prod"))).toBeNull();
  for (const request of requests) {
    const single = await loadConnectorSystem(
      tenant_id,
      request.connector_id,
      request.environment,
      ctx.db,
    );
    expect(
      systems.get(connectorSystemKey(request.connector_id, request.environment))?.connector ?? null,
    ).toEqual(single?.connector ?? null);
  }
});

test("batch authority metadata selects primary and client separately and freezes only its own read", async () => {
  const tenant_id = (await seedTenant(ctx.db)).id;
  const connector = await batchConnector(tenant_id, "selection", "dev");
  await batchCredential(connector, "bearer", 2, new Date(1));
  const primary = await batchCredential(connector, "oauth2", 3, new Date(2));
  const client = await batchCredential(connector, "oauth2_client", 4, new Date(3));
  const request = { connector_id: connector.id, environment: "dev" as const };
  const systems = await loadConnectorSystems(tenant_id, [request], ctx.db);
  const system = systems.get(connectorSystemKey(connector.id, "dev"));
  if (!system) throw new Error("missing batch system fixture");
  const first = await system.getAuthorityMetadata();
  expect(first.binding.primary).toEqual({
    id: primary.id,
    revision: 3,
    mode: "oauth2",
    scopes: ["read", "write"],
    connection_id: null,
  });
  expect(first.binding.client).toEqual({ id: client.id, revision: 4 });
  expect(first.available).toBe(true);
  expect(first).toEqual(
    await getCredentialAuthorityMetadata(tenant_id, connector.id, "dev", ctx.db),
  );
  await ctx.db
    .update(vaultItems)
    .set({ authority_revision: 5, oauth2_expires_at: new Date(0) })
    .where(and(eq(vaultItems.tenant_id, tenant_id), eq(vaultItems.id, primary.id)));
  first.available = false;
  expect((await system.getAuthorityMetadata()).available).toBe(true);
  const refreshed = await loadConnectorSystems(tenant_id, [request], ctx.db);
  const current = await refreshed
    .get(connectorSystemKey(connector.id, "dev"))
    ?.getAuthorityMetadata();
  expect(current?.binding.primary?.revision).toBe(5);
  expect(current?.available).toBe(false);
});

test("batch connection availability binds the exact tenant secret version and refresh state", async () => {
  const tenant_id = (await seedTenant(ctx.db)).id;
  const foreignTenant = (await seedTenant(ctx.db)).id;
  const connector = await batchConnector(tenant_id, "connection", "dev");
  const primary = await batchCredential(connector, "oauth2", 3, new Date(1));
  const [connection] = await ctx.db
    .insert(outboundConnections)
    .values({
      tenant_id,
      name: "batch",
      base_url: "https://provider.example.test",
      issuer: "https://provider.example.test",
      authorization_endpoint: "https://provider.example.test/authorize",
      token_endpoint: "https://provider.example.test/token",
      client_id: "fixture",
      scopes: ["read", "write"],
      granted_scopes: ["read"],
      access_token_version: 2,
      refresh_token_version: 1,
      expires_at: new Date(0),
      authority_revision: 4,
    })
    .returning();
  if (!connection) throw new Error("missing batch connection fixture");
  await ctx.db
    .update(vaultItems)
    .set({ connection_id: connection.id })
    .where(and(eq(vaultItems.tenant_id, tenant_id), eq(vaultItems.id, primary.id)));
  const token = {
    ciphertext: Buffer.from("not encrypted"),
    iv: Buffer.from("not an iv"),
    auth_tag: Buffer.from("not a tag"),
  };
  const name = secretNames(tenant_id, connection.name).access;
  await ctx.db.insert(runtimeSecretVersions).values([
    { ...token, name, version: 1 },
    { ...token, name: secretNames(foreignTenant, connection.name).access, version: 2 },
  ]);
  const read = async () => {
    const systems = await loadConnectorSystems(
      tenant_id,
      [{ connector_id: connector.id, environment: "dev" }],
      ctx.db,
    );
    const system = systems.get(connectorSystemKey(connector.id, "dev"));
    if (!system) throw new Error("missing batch system fixture");
    return system.getAuthorityMetadata();
  };
  expect((await read()).available).toBe(false);
  await ctx.db.insert(runtimeSecretVersions).values({ ...token, name, version: 2 });
  const available = await read();
  expect(available.available).toBe(true);
  expect(available.binding.connection?.revision).toBe(4);
  expect(available.binding.connection?.granted_scopes).toEqual(["read"]);
  await ctx.db
    .update(runtimeSecretVersions)
    .set({ revoked_at: new Date(1) })
    .where(and(eq(runtimeSecretVersions.name, name), eq(runtimeSecretVersions.version, 2)));
  expect((await read()).available).toBe(false);
  await ctx.db
    .update(runtimeSecretVersions)
    .set({ revoked_at: null })
    .where(and(eq(runtimeSecretVersions.name, name), eq(runtimeSecretVersions.version, 2)));
  await ctx.db
    .update(outboundConnections)
    .set({ refresh_failed_at: new Date(1) })
    .where(
      and(eq(outboundConnections.tenant_id, tenant_id), eq(outboundConnections.id, connection.id)),
    );
  expect((await read()).available).toBe(false);
});
