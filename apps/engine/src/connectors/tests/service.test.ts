import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, events, tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  createConnector,
  deleteConnector,
  getConnector,
  listConnectors,
  setConnectorEnabled,
  updateConnector,
} from "../service.ts";

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("connectors_svc");
});

afterAll(async () => {
  await ctx.cleanup();
});

async function seedTenant(): Promise<string> {
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: `t-${Math.random().toString(36).slice(2, 8)}`, display_name: "T" }) // allow-random: legacy; review before changing
    .returning();
  return t!.id;
}

describe("connectors/service", () => {
  test("persists trusted user and system-account actor provenance", async () => {
    const tenant_id = await seedTenant();
    const user_id = "10000000-0000-4000-8000-000000000001";
    const system_account_id = "10000000-0000-4000-8000-000000000002";
    const userConnector = await createConnector(
      {
        tenant_id,
        input: {
          name: "User connector",
          driver: "http",
          environment: "dev",
          auth_type: "none",
          base_url: "https://user.example.test",
        },
        actor_id: user_id,
        actor: { kind: "user", id: user_id },
      },
      ctx.db,
    );
    const machineConnector = await createConnector(
      {
        tenant_id,
        input: {
          name: "Machine connector",
          driver: "http",
          environment: "dev",
          auth_type: "none",
          base_url: "https://machine.example.test",
        },
        actor_id: system_account_id,
        actor: { kind: "system_account", id: system_account_id },
      },
      ctx.db,
    );
    const untrustedConnector = await createConnector(
      {
        tenant_id,
        input: {
          name: "Untrusted connector",
          driver: "http",
          environment: "dev",
          auth_type: "none",
          base_url: "https://untrusted.example.test",
        },
        actor_id: "10000000-0000-4000-8000-000000000003",
        actor: null,
      },
      ctx.db,
    );
    await updateConnector(
      tenant_id,
      machineConnector.id,
      { name: "Machine connector updated" },
      { kind: "system_account", id: system_account_id },
      ctx.db,
    );
    const rows = await ctx.db
      .select({
        actor_type: auditLog.actor_type,
        actor_id: auditLog.actor_id,
        resource_id: auditLog.resource_id,
      })
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, tenant_id), eq(auditLog.resource_type, "connector")));
    expect(rows).toEqual(
      expect.arrayContaining([
        { actor_type: "user", actor_id: user_id, resource_id: userConnector.id },
        {
          actor_type: "system_account",
          actor_id: system_account_id,
          resource_id: machineConnector.id,
        },
        { actor_type: "unknown", actor_id: null, resource_id: untrustedConnector.id },
      ]),
    );
    const machineRows = rows.filter((row) => row.resource_id === machineConnector.id);
    expect(machineRows).toHaveLength(2);
    expect(
      machineRows.every(
        (row) => row.actor_type === "system_account" && row.actor_id === system_account_id,
      ),
    ).toBe(true);
  });

  test("create + get + list + patch + delete", async () => {
    const tenant_id = await seedTenant();
    const created = await createConnector(
      {
        tenant_id,
        input: {
          name: "API One",
          driver: "http",
          environment: "dev",
          base_url: "https://one.example.test",
          auth_type: "bearer",
          config: {},
        },
        actor_id: null,
      },
      ctx.db,
    );
    expect(created.slug).toBe("api-one");
    expect(created.environment).toBe("dev");
    expect(created.auth_type).toBe("bearer");

    const fetched = await getConnector(tenant_id, created.id, ctx.db);
    expect(fetched?.id).toBe(created.id);

    const prod = await createConnector(
      {
        tenant_id,
        input: {
          name: "API One",
          slug: "api-one",
          driver: "http",
          environment: "prod",
          base_url: "https://one.example.test",
          auth_type: "bearer",
          config: {},
        },
        actor_id: null,
      },
      ctx.db,
    );
    expect(prod.environment).toBe("prod");

    const devList = await listConnectors(tenant_id, { environment: "dev" }, ctx.db);
    expect(devList.rows.map((c) => c.environment)).toEqual(["dev"]);
    expect(devList.total).toBe(1);

    const prodList = await listConnectors(tenant_id, { environment: "prod" }, ctx.db);
    expect(prodList.rows.map((c) => c.environment)).toEqual(["prod"]);
    expect(prodList.total).toBe(1);

    const all = await listConnectors(tenant_id, {}, ctx.db);
    expect(all.rows).toHaveLength(2);
    expect(all.total).toBe(2);

    const patched = await updateConnector(
      tenant_id,
      created.id,
      { name: "API One v2" },
      null,
      ctx.db,
    );
    expect(patched?.display_name).toBe("API One v2");

    const ok = await deleteConnector(tenant_id, created.id, null, ctx.db);
    expect(ok).toBe(true);
    const gone = await getConnector(tenant_id, created.id, ctx.db);
    expect(gone).toBeNull();
  });

  test("every connector change reaches the live feed as ids only", async () => {
    const tenant_id = await seedTenant();
    const input = {
      name: "Live One",
      driver: "http" as const,
      environment: "dev" as const,
      base_url: "https://live.example.test",
      auth_type: "bearer" as const,
      config: {},
    };
    const created = await createConnector({ tenant_id, input, actor_id: null }, ctx.db);
    await createConnector({ tenant_id, input, actor_id: null }, ctx.db);
    await updateConnector(tenant_id, created.id, { name: "Live Two" }, null, ctx.db);
    await setConnectorEnabled(tenant_id, created.id, false, null, ctx.db);
    await deleteConnector(tenant_id, created.id, null, ctx.db);
    const rows = await ctx.db
      .select({ type: events.type, payload: events.payload })
      .from(events)
      .where(and(eq(events.tenant_id, tenant_id), eq(events.channel, "resource.lifecycle")))
      .orderBy(events.id);
    expect(rows).toEqual(
      [
        "connector.created",
        "connector.updated",
        "connector.updated",
        "connector.updated",
        "connector.deleted",
      ].map((type) => ({ type, payload: { connector_id: created.id } })),
    );
  });

  test("operator_quirks round-trip through create + patch + clear", async () => {
    const tenant_id = await seedTenant();
    const created = await createConnector(
      {
        tenant_id,
        input: {
          name: "Notes API",
          driver: "http",
          environment: "dev",
          base_url: "https://notes.example.test",
          auth_type: "none",
          operator_quirks: { error_handling: "treat 422 as success on /upsert" },
        },
        actor_id: null,
      },
      ctx.db,
    );
    expect(created.operator_quirks.error_handling).toBe("treat 422 as success on /upsert");

    const patched = await updateConnector(
      tenant_id,
      created.id,
      { operator_quirks: { auth: "always send ?api-version=2025-01-01" } },
      null,
      ctx.db,
    );
    expect(patched?.operator_quirks.auth).toBe("always send ?api-version=2025-01-01");

    const cleared = await updateConnector(
      tenant_id,
      created.id,
      { operator_quirks: {} },
      null,
      ctx.db,
    );
    expect(cleared?.operator_quirks).toEqual({});
  });

  test("createConnector persists template binding metadata and snapshot", async () => {
    const tenant_id = await seedTenant();
    const created = await createConnector(
      {
        tenant_id,
        input: {
          name: "Stripe",
          slug: "stripe",
          driver: "http",
          environment: "dev",
          auth_type: "bearer",
          template_slug: "stripe",
        },
        actor_id: null,
      },
      ctx.db,
    );
    expect(created.template_slug).toBe("stripe");
    expect(created.template_name).toBeTruthy();
    expect(created.template_source).toBe("builtin");
    expect(created.template_version).toBe(1);
    expect(created.template_snapshot?.slug).toBe("stripe");
  });

  test("a person's description and category survive the template enrichment", async () => {
    const tenant_id = await seedTenant();
    const created = await createConnector(
      {
        tenant_id,
        input: {
          name: "Stripe billing",
          slug: "stripe-billing",
          driver: "http",
          environment: "dev",
          auth_type: "bearer",
          template_slug: "stripe",
          description: "Charges customers for the monthly plan.",
          category: "billing",
        },
        actor_id: null,
      },
      ctx.db,
    );
    expect(created.description).toBe("Charges customers for the monthly plan.");
    expect(created.description_source).toBe("human");
    expect(created.category).toBe("billing");
    expect(created.category_source).toBe("human");
  });
});

describe("connectors/service — sorted by name", () => {
  test("names sort without regard to case", async () => {
    const tenant_id = await seedTenant();
    for (const name of ["cherry", "Banana", "apple"])
      await createConnector(
        {
          tenant_id,
          input: {
            name,
            driver: "http",
            environment: "dev",
            base_url: `https://${name.toLowerCase()}.example.test`,
            auth_type: "none",
            config: {},
          },
          actor_id: null,
        },
        ctx.db,
      );
    const { rows } = await listConnectors(tenant_id, { sort: "name", order: "asc" }, ctx.db);
    expect(rows.map((row) => row.display_name)).toEqual(["apple", "Banana", "cherry"]);
  });
});
