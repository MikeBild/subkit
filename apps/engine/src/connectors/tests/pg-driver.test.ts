import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import { seedTenant } from "../../test-helpers/seed.ts";
import { probeConnector } from "../drivers/index.ts";
import { closeAllPools, pgQueryWithCount, probePgConnector } from "../drivers/postgres.ts";
import { createConnector, getConnector } from "../service.ts";

let ctx: TestDb;
let tenantId: string;

beforeAll(async () => {
  ctx = await createTestDb("pg_driver");
  tenantId = (await seedTenant(ctx.db, { slug: "pg-t", display_name: "pg tenant" })).id;
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
    const probe = await probePgConnector(conn!, ctx.db);
    expect(probe.ok).toBe(true);
    expect(probe.latency_ms).toBeGreaterThanOrEqual(0);

    const dispatched = await probeConnector({
      db: ctx.db,
      tenant_id: tenantId,
      connector: conn!,
    });
    expect(dispatched.ok).toBe(true);

    const res = await pgQueryWithCount<{ n: number }>({
      exec: ctx.db,
      connector: conn!,
      sql: "SELECT 1 as n",
    });
    expect(res.rows[0]?.n).toBe(1);
    expect(res.row_count).toBe(1);
  });
});
