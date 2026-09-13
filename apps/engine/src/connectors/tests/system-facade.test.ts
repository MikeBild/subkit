// Smoke test for the `ConnectorSystem` facade. The facade is a thin
// orchestrator over `getConnectorForEnvironment` + `getCredentialForConnector`
// + `listDocs`; the underlying primitives have their own coverage. This
// file proves the facade composes them correctly.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createConnector } from "../service.ts";
import { loadConnectorSystem } from "../system.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("connectors_facade");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedTenant(): Promise<string> {
  const [t] = await ctx.db
    .insert(tenants)
    .values({
      slug: `t-${Math.random().toString(36).slice(2, 8)}`, // allow-random: per-test isolation
      display_name: "T",
    })
    .returning();
  return t!.id;
}

describe("ConnectorSystem facade", () => {
  test("loadConnectorSystem returns null for unknown connector", async () => {
    const tenant_id = await seedTenant();
    const sys = await loadConnectorSystem(
      tenant_id,
      "00000000-0000-0000-0000-000000000000",
      "dev",
      ctx.db,
    );
    expect(sys).toBeNull();
  });

  test("facade exposes connector + driver + tenant identity", async () => {
    const tenant_id = await seedTenant();
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
    const tenant_id = await seedTenant();
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
    const tenant_id = await seedTenant();
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
    const tenant_id = await seedTenant();
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

    // Asking for prod when only dev exists falls back to the dev row.
    const sys = await loadConnectorSystem(tenant_id, created.id, "prod", ctx.db);
    expect(sys).not.toBeNull();
    expect(sys!.id).toBe(created.id);
    expect(sys!.environment).toBe("dev");
  });
});
