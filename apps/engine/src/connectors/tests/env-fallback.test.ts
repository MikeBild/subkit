import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { createDeterministicHexFactory } from "../../test-helpers/determinism/ids.ts";
import { createConnector, getConnectorForEnvironment, setConnectorEnabled } from "../service.ts";

const nextHex = createDeterministicHexFactory(0xe7fa11);

let ctx: TestDb;

beforeAll(async () => {
  ctx = await createTestDb("connector_env_fallback");
});
afterAll(async () => {
  await ctx.cleanup();
});

async function seedTenant(): Promise<string> {
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: `t-${nextHex(4)}`, display_name: "T" })
    .returning();
  return t!.id;
}

describe("getConnectorForEnvironment", () => {
  test("prod request with only a dev binding falls back to dev (signal fires)", async () => {
    const tenant_id = await seedTenant();
    const dev = await createConnector(
      {
        tenant_id,
        input: {
          name: "Billing API",
          driver: "http",
          environment: "dev",
          base_url: "https://dev.billing.test",
          auth_type: "bearer",
          config: {},
        },
        actor_id: null,
      },
      ctx.db,
    );

    const resolved = await getConnectorForEnvironment(tenant_id, dev.id, "prod", ctx.db);
    expect(resolved).not.toBeNull();
    expect(resolved?.environment).toBe("dev");
    expect(resolved?.environment).not.toBe("prod");
  });

  test("prod request with a prod sibling resolves to prod (no fallback, no signal)", async () => {
    const tenant_id = await seedTenant();
    const dev = await createConnector(
      {
        tenant_id,
        input: {
          name: "Orders API",
          driver: "http",
          environment: "dev",
          base_url: "https://dev.orders.test",
          auth_type: "bearer",
          config: {},
        },
        actor_id: null,
      },
      ctx.db,
    );
    await createConnector(
      {
        tenant_id,
        input: {
          name: "Orders API",
          driver: "http",
          environment: "prod",
          base_url: "https://prod.orders.test",
          auth_type: "bearer",
          config: {},
        },
        actor_id: null,
      },
      ctx.db,
    );

    const resolved = await getConnectorForEnvironment(tenant_id, dev.id, "prod", ctx.db);
    expect(resolved?.environment).toBe("prod");
    expect(resolved?.base_url).toBe("https://prod.orders.test");
  });

  test("matching-environment request returns the connector as-is", async () => {
    const tenant_id = await seedTenant();
    const dev = await createConnector(
      {
        tenant_id,
        input: {
          name: "Inventory API",
          driver: "http",
          environment: "dev",
          base_url: "https://dev.inventory.test",
          auth_type: "bearer",
          config: {},
        },
        actor_id: null,
      },
      ctx.db,
    );

    const resolved = await getConnectorForEnvironment(tenant_id, dev.id, "dev", ctx.db);
    expect(resolved?.id).toBe(dev.id);
    expect(resolved?.environment).toBe("dev");
  });

  test("a disabled twin is still the one resolved — never skipped for the connector the step names", async () => {
    const tenant_id = await seedTenant();
    const prod = await createConnector(
      {
        tenant_id,
        input: {
          name: "Mail API",
          driver: "http",
          environment: "prod",
          base_url: "https://prod.mail.test",
          auth_type: "bearer",
          config: {},
        },
        actor_id: null,
      },
      ctx.db,
    );
    const devTwin = await createConnector(
      {
        tenant_id,
        input: {
          name: "Mail API",
          driver: "http",
          environment: "dev",
          base_url: "https://dev.mail.test",
          auth_type: "bearer",
          config: {},
        },
        actor_id: null,
      },
      ctx.db,
    );
    await setConnectorEnabled(tenant_id, devTwin.id, false, null, ctx.db);

    const resolved = await getConnectorForEnvironment(tenant_id, prod.id, "dev", ctx.db);
    expect(resolved?.id).toBe(devTwin.id);
    expect(resolved?.environment).toBe("dev");
    expect(resolved?.enabled).toBe(false);
  });
});
