import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { tenants } from "../../db/schema/index.ts";
import { createTestDb, type TestDb } from "../../db/tests/setup.ts";
import type { ConnectorView } from "../types.ts";
import {
  closeAllPools,
  closePoolForConnector,
  getPoolForConnector,
  pgQueryCursor,
  pgQueryWithCount,
  pgTransaction,
  probePgConnector,
} from "./postgres.ts";

const skip = process.env.REQUIRES_PG === "0";

let ctx: TestDb;
let tenantId: string;
let counter = 0;

function makeConnector(overrides: Partial<ConnectorView> = {}): ConnectorView {
  counter += 1;
  return {
    id: `pg-driver-test-${counter}`,
    tenant_id: tenantId,
    slug: `pg-driver-test-${counter}`,
    display_name: "pg driver test",
    driver: "postgres",
    environment: "dev",
    auth_type: "none",
    base_url: null,
    dsn: ctx.url,
    config: {},
    template_slug: null,
    template_snapshot: null,
    ...overrides,
  } as unknown as ConnectorView;
}

beforeAll(async () => {
  if (skip) return;
  ctx = await createTestDb("pg-driver-unit");
  const [tenant] = await ctx.db
    .insert(tenants)
    .values({ slug: "pg-driver-test", display_name: "PG driver" })
    .returning();
  if (!tenant) throw new Error("tenant fixture missing");
  tenantId = tenant.id;
  await ctx.pool.query(
    "CREATE TABLE public.scratch_items (id serial primary key, name text not null)",
  );
}, 60_000);

afterEach(async () => {
  if (skip) return;
  await ctx.pool.query("TRUNCATE public.scratch_items RESTART IDENTITY");
});

afterAll(async () => {
  if (skip) return;
  await closeAllPools();
  await ctx.cleanup();
}, 30_000);

describe.skipIf(skip)("postgres driver — pool lifecycle", () => {
  test("getPoolForConnector throws when dsn is missing", async () => {
    const c = makeConnector({ dsn: null });
    await expect(getPoolForConnector(c, ctx.db)).rejects.toThrow(/no dsn/);
  });

  test("getPoolForConnector returns the same pool for repeated calls on the same connector", async () => {
    const c = makeConnector();
    const p1 = await getPoolForConnector(c, ctx.db);
    const p2 = await getPoolForConnector(c, ctx.db);
    expect(p1).toBe(p2);
  });

  test("parallel pool acquisition shares one pool and a changed DSN retires the former pool", async () => {
    const connector = makeConnector();
    const acquired = await Promise.all(
      Array.from({ length: 10 }, () => getPoolForConnector(connector, ctx.db)),
    );
    expect(new Set(acquired).size).toBe(1);
    const changed = new URL(connector.dsn as string);
    changed.searchParams.set("application_name", "changed-fixture");
    const replacement = await getPoolForConnector({ ...connector, dsn: changed.href }, ctx.db);
    expect(replacement).not.toBe(acquired[0]);
    await expect(acquired[0]!.connect()).rejects.toThrow("end");
    await closePoolForConnector(connector);
  });

  test("closePoolForConnector is idempotent when no pool has been opened yet", async () => {
    const c = makeConnector();
    await expect(closePoolForConnector(c)).resolves.toBeUndefined();
  });

  test("closePoolForConnector evicts the cached pool; the next call opens a fresh one", async () => {
    const c = makeConnector();
    const p1 = await getPoolForConnector(c, ctx.db);
    await closePoolForConnector(c);
    const p2 = await getPoolForConnector(c, ctx.db);
    expect(p2).not.toBe(p1);
    await closePoolForConnector(c);
  });
});

describe.skipIf(skip)("probePgConnector", () => {
  test("ok:true against the reachable scratch database", async () => {
    const probe = await probePgConnector(makeConnector(), ctx.db);
    expect(probe.ok).toBe(true);
    expect(probe.latency_ms).toBeGreaterThanOrEqual(0);
    expect(probe.error_code).toBeUndefined();
  });

  test("ok:false credential_missing when the connector has no dsn", async () => {
    const probe = await probePgConnector(makeConnector({ dsn: null }), ctx.db);
    expect(probe.ok).toBe(false);
    expect(probe.error_code).toBe("credential_missing");
    expect(probe.detail).toContain("no dsn");
    expect(probe.latency_ms).toBe(0);
  });

  test("ok:false credential_invalid on a bad password (SQLSTATE 28P01)", async () => {
    const bad = new URL(ctx.url);
    bad.password = "definitely-wrong-password";
    const probe = await probePgConnector(makeConnector({ dsn: bad.toString() }), ctx.db);
    expect(probe.ok).toBe(false);
    expect(probe.error_code).toBe("credential_invalid");
  });

  test("ok:false remote_resource_not_found when the database doesn't exist (SQLSTATE 3D000)", async () => {
    const bad = new URL(ctx.url);
    bad.pathname = "/no_such_database_at_all_xyz";
    const probe = await probePgConnector(makeConnector({ dsn: bad.toString() }), ctx.db);
    expect(probe.ok).toBe(false);
    expect(probe.error_code).toBe("remote_resource_not_found");
  });
});

describe.skipIf(skip)("pgQueryWithCount", () => {
  test("SELECT returns rows and a matching row_count", async () => {
    const res = await pgQueryWithCount<{ n: number }>({
      connector: makeConnector(),
      exec: ctx.db,
      sql: "SELECT 1 as n",
    });
    expect(res.rows).toEqual([{ n: 1 }]);
    expect(res.row_count).toBe(1);
  });

  test("parameterised INSERT without RETURNING reports row_count but no rows", async () => {
    const res = await pgQueryWithCount({
      connector: makeConnector(),
      exec: ctx.db,
      sql: "INSERT INTO public.scratch_items (name) VALUES ($1), ($2)",
      params: ["a", "b"],
    });
    expect(res.rows).toEqual([]);
    expect(res.row_count).toBe(2);
  });

  test("params default to an empty array when omitted", async () => {
    const res = await pgQueryWithCount<{ n: number }>({
      connector: makeConnector(),
      exec: ctx.db,
      sql: "SELECT 2 as n",
    });
    expect(res.rows[0]?.n).toBe(2);
  });
});

describe.skipIf(skip)("pgTransaction", () => {
  test("commits multiple statements atomically and reports per-statement + total counts", async () => {
    const result = await pgTransaction<{ id: number; name: string }>({
      connector: makeConnector(),
      exec: ctx.db,
      statements: [
        {
          query: "INSERT INTO public.scratch_items (name) VALUES ($1) RETURNING id, name",
          params: ["x"],
        },
        {
          query: "INSERT INTO public.scratch_items (name) VALUES ($1) RETURNING id, name",
          params: ["y"],
        },
      ],
    });
    expect(result.rows_per_statement.length).toBe(2);
    expect(result.rows_per_statement[0]?.[0]?.name).toBe("x");
    expect(result.rows_per_statement[1]?.[0]?.name).toBe("y");
    expect(result.row_count_per_statement).toEqual([1, 1]);
    expect(result.total_row_count).toBe(2);
    const check = await ctx.pool.query("SELECT count(*)::int as n FROM public.scratch_items");
    expect(check.rows[0].n).toBe(2);
  });

  test("rolls back every statement when a later one fails", async () => {
    await expect(
      pgTransaction({
        connector: makeConnector(),
        exec: ctx.db,
        statements: [
          { query: "INSERT INTO public.scratch_items (name) VALUES ($1)", params: ["ok"] },
          {
            query: "INSERT INTO public.scratch_items (name) VALUES ($1, $2)",
            params: ["bad", "extra"],
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "42601" });
    const check = await ctx.pool.query("SELECT count(*)::int as n FROM public.scratch_items");
    expect(check.rows[0].n).toBe(0);
  });

  test("onStatement observes rows/rowCount per index in order; a thrown guard rolls back", async () => {
    const seenIndexes: number[] = [];
    await expect(
      pgTransaction({
        connector: makeConnector(),
        exec: ctx.db,
        statements: [
          { query: "INSERT INTO public.scratch_items (name) VALUES ($1)", params: ["a"] },
          { query: "INSERT INTO public.scratch_items (name) VALUES ($1)", params: ["b"] },
        ],
        onStatement: (index, _rows, rowCount) => {
          seenIndexes.push(index);
          expect(rowCount).toBe(1);
          if (index === 1) throw new Error("guard rejected second statement");
        },
      }),
    ).rejects.toThrow("guard rejected second statement");
    expect(seenIndexes).toEqual([0, 1]);
    const check = await ctx.pool.query("SELECT count(*)::int as n FROM public.scratch_items");
    expect(check.rows[0].n).toBe(0);
  });
});

describe.skipIf(skip)("pgQueryCursor", () => {
  test("streams rows across multiple fetch batches and preserves order", async () => {
    for (let i = 0; i < 25; i++) {
      await ctx.pool.query("INSERT INTO public.scratch_items (name) VALUES ($1)", [`row-${i}`]);
    }
    const rows = await pgQueryCursor<{ id: number; name: string }>({
      connector: makeConnector(),
      exec: ctx.db,
      sql: "SELECT id, name FROM public.scratch_items ORDER BY id",
      fetch_size: 10,
    });
    expect(rows.length).toBe(25);
    expect(rows[0]?.name).toBe("row-0");
    expect(rows[24]?.name).toBe("row-24");
  });

  test("empty result set returns an empty array", async () => {
    const rows = await pgQueryCursor({
      connector: makeConnector(),
      exec: ctx.db,
      sql: "SELECT * FROM public.scratch_items WHERE name = $1",
      params: ["does-not-exist"],
      fetch_size: 10,
    });
    expect(rows).toEqual([]);
  });

  test("a malformed query rolls back and rejects", async () => {
    await expect(
      pgQueryCursor({
        connector: makeConnector(),
        exec: ctx.db,
        sql: "SELECT * FROM no_such_table_xyz",
        fetch_size: 10,
      }),
    ).rejects.toThrow();
  });
});
