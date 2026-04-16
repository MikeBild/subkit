import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { probeConnector } from "../drivers/index.ts";
import { closeAllPools, pgQuery, probePgConnector } from "../drivers/postgres.ts";
import { createConnector, getConnector } from "../service.ts";

let ctx: TestDb;
let tenantId: string;

beforeAll(async () => {
  ctx = await createTestDb("pg_driver");
  const [t] = await ctx.db
    .insert(tenants)
    .values({ slug: "pg-t", display_name: "pg tenant" })
    .returning();
  tenantId = t!.id;
});

afterAll(async () => {
  await closeAllPools();
  await ctx.cleanup();
});

describe("pg driver", () => {
  test("probe against the running postgres returns ok", async () => {
    const c = await createConnector(
      {
        tenant_id: tenantId,
        input: {
          name: "pg",
          driver: "postgres",
          environment: "dev",
          dsn: ctx.url,
          auth_type: "none",
          config: {},
        },
        actor_id: null,
      },
      ctx.db,
    );
    const conn = await getConnector(tenantId, c.id, ctx.db);
    expect(conn).not.toBeNull();
    const probe = await probePgConnector(conn!);
    expect(probe.ok).toBe(true);
    expect(probe.latency_ms).toBeGreaterThanOrEqual(0);

    // driver registry dispatch
    const dispatched = await probeConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: conn!,
    });
    expect(dispatched.ok).toBe(true);

    // run an arbitrary query
    const rows = await pgQuery<{ n: number }>({
      connector: conn!,
      sql: "SELECT 1 as n",
    });
    expect(rows[0]?.n).toBe(1);
  });
});
