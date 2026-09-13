import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import {
  createConnector,
  deleteConnector,
  getConnector,
  listConnectors,
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

    // Same name in a different environment should succeed thanks to the
    // composite (tenant, slug, environment) key.
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
    // `total` respects the same filters as the page (ground truth).
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

    // Empty object clears every category in one go.
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
});
