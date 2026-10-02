// #25 — connector environment fallback resolution.
//
// `getConnectorForEnvironment(tenant, id, env)` resolves the connector
// binding for the requested execution environment. When the requested
// connector already matches the environment it is returned as-is. When it
// does NOT, the resolver looks for a same-slug sibling in the requested
// environment and returns that; if none exists it FALLS BACK to the
// original binding (load-bearing for single-env tenants).
//
// The dispatch step emits a `connector.environment.fallback` warn + a
// `connector_env_fallback_total` metric exactly when the resolved
// connector's environment differs from the requested one — i.e. the
// fallback branch below. These tests pin that resolution contract (the
// trigger condition for the signal) at the DB layer.

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
    // Fallback: resolved environment differs from the requested one — this
    // is precisely the dispatch condition that emits the warn + metric.
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
    // Same slug, prod environment — the resolver should prefer this.
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

    // A dev run of a step that names the prod connector. Resolution answers
    // "which connector", not "may it serve": handing back the enabled prod
    // connector here would send a dev preview to production because someone
    // switched the dev twin off. The dispatcher refuses the disabled twin by
    // name instead (execution/tests/disabled-connector-refusal.test.ts).
    const resolved = await getConnectorForEnvironment(tenant_id, prod.id, "dev", ctx.db);
    expect(resolved?.id).toBe(devTwin.id);
    expect(resolved?.environment).toBe("dev");
    expect(resolved?.enabled).toBe(false);
  });
});
