import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { createTestDb, type TestDb } from "../../../db/tests/setup.ts";
import { logger } from "../../../logging/index.ts";
import { seedTenant } from "../../../test-helpers/seed.ts";
import { _withEgressTenantOriginForTests } from "../../egress-guard.ts";
import type { ConnectorView } from "../../types.ts";
import {
  CONNECTOR_CONNECT_TIMEOUT_MS,
  CONNECTOR_STATEMENT_TIMEOUT_MS,
  closePoolForConnector,
  getPoolForConnector,
  pgQueryCursor,
  pgQueryWithCount,
  pgTransaction,
  postgresConnectorTarget,
  probePgConnector,
} from "../postgres.ts";

let ctx: TestDb;
let tenantA: string;
let tenantB: string;
let counter = 0;
const opened: ConnectorView[] = [];

function pgConnector(overrides: Partial<ConnectorView> = {}): ConnectorView {
  counter += 1;
  const connector = {
    id: `pg-binding-${counter}`,
    tenant_id: tenantA,
    slug: `pg-binding-${counter}`,
    driver: "postgres",
    environment: "dev",
    auth_type: "none",
    base_url: null,
    dsn: ctx.url,
    config: {},
    ...overrides,
  } as unknown as ConnectorView;
  opened.push(connector);
  return connector;
}

beforeAll(async () => {
  ctx = await createTestDb("pg-driver-binding");
  tenantA = (await seedTenant(ctx.db, { slug: "pg-binding-a", display_name: "PG A" })).id;
  tenantB = (await seedTenant(ctx.db, { slug: "pg-binding-b", display_name: "PG B" })).id;
  await ctx.pool.query(
    "CREATE TABLE public.binding_items (id serial primary key, name text not null)",
  );
}, 60_000);

afterAll(async () => {
  await Promise.all(opened.map((connector) => closePoolForConnector(connector)));
  await ctx.cleanup();
}, 30_000);

const hostile = "x'); DROP TABLE public.binding_items; --";

describe("postgres parameter binding", () => {
  test("a bound value containing SQL is stored literally and never executed", async () => {
    const connector = pgConnector();
    const inserted = await pgQueryWithCount<{ name: string }>({
      exec: ctx.db,
      connector,
      sql: "INSERT INTO public.binding_items (name) VALUES ($1) RETURNING name",
      params: [hostile],
    });
    expect(inserted).toEqual({ rows: [{ name: hostile }], row_count: 1 });
    const { rows } = await ctx.pool.query("SELECT name FROM public.binding_items WHERE name = $1", [
      hostile,
    ]);
    expect(rows).toEqual([{ name: hostile }]);
  });

  test("cursor queries bind their parameters into the declared cursor", async () => {
    const connector = pgConnector();
    const rows = await pgQueryCursor<{ value: string }>({
      exec: ctx.db,
      connector,
      sql: "SELECT $1::text AS value FROM generate_series(1, 3)",
      params: [hostile],
      fetch_size: 2,
    });
    expect(rows).toEqual([{ value: hostile }, { value: hostile }, { value: hostile }]);
  });

  test("a cursor whose row count is an exact multiple of the fetch size returns every row once", async () => {
    const rows = await pgQueryCursor<{ n: number }>({
      exec: ctx.db,
      connector: pgConnector(),
      sql: "SELECT n FROM generate_series(1, 4) AS n ORDER BY n",
      fetch_size: 2,
    });
    expect(rows.map((row) => row.n)).toEqual([1, 2, 3, 4]);
  });

  test("transaction statements bind their own parameters", async () => {
    const result = await pgTransaction<{ v: string }>({
      exec: ctx.db,
      connector: pgConnector(),
      statements: [
        { query: "SELECT $1::text AS v", params: [hostile] },
        { query: "SELECT 'plain'::text AS v" },
      ],
    });
    expect(result.rows_per_statement).toEqual([[{ v: hostile }], [{ v: "plain" }]]);
    expect(result.row_count_per_statement).toEqual([1, 1]);
    expect(result.total_row_count).toBe(2);
  });

  test("an empty transaction commits and reports zero rows", async () => {
    const result = await pgTransaction({ exec: ctx.db, connector: pgConnector(), statements: [] });
    expect(result).toEqual({
      rows_per_statement: [],
      row_count_per_statement: [],
      total_row_count: 0,
    });
  });
});

describe("postgres credential use and egress", () => {
  test("credential use is reported once per query", async () => {
    let uses = 0;
    await pgQueryWithCount({
      exec: ctx.db,
      connector: pgConnector(),
      sql: "SELECT 1",
      on_credential_use: async () => {
        uses += 1;
      },
    });
    expect(uses).toBe(1);
  });

  test("credential use is reported once per cursor and per transaction", async () => {
    let uses = 0;
    const on_credential_use = async () => {
      uses += 1;
    };
    await pgQueryCursor({
      exec: ctx.db,
      connector: pgConnector(),
      sql: "SELECT 1",
      fetch_size: 10,
      on_credential_use,
    });
    await pgTransaction({
      exec: ctx.db,
      connector: pgConnector(),
      statements: [{ query: "SELECT 1" }],
      on_credential_use,
    });
    expect(uses).toBe(2);
  });

  test("a private DSN in strict mode is refused before the credential is used", async () => {
    let uses = 0;
    const error = await _withEgressTenantOriginForTests(
      async () => "self_service",
      () =>
        pgQueryWithCount({
          exec: ctx.db,
          connector: pgConnector({ dsn: "postgres://user:secret-password@10.0.0.9:5432/db" }),
          sql: "SELECT 1",
          on_credential_use: async () => {
            uses += 1;
          },
        }),
    ).catch((caught: unknown) => caught);
    expect((error as Error).message).toContain("private_ip_blocked");
    expect((error as Error).message).not.toContain("secret-password");
    expect(uses).toBe(0);
  });

  test("a connector without a DSN has no target", () => {
    expect(() => postgresConnectorTarget({ id: "pg-none", dsn: null })).toThrow(
      "Postgres connector pg-none has no dsn; cannot open pool",
    );
  });

  test("a connector target names the DSN host and database", () => {
    const target = postgresConnectorTarget({
      id: "pg-t",
      dsn: "postgres://u@db.example.com:6543/app",
    });
    expect(target.hostname).toBe("db.example.com");
    expect(target.port).toBe("6543");
  });
});

describe("postgres pools", () => {
  test("the same connector id in two tenants gets two pools and closing one keeps the other", async () => {
    const forA = pgConnector({ id: "pg-shared-id" });
    const forB = pgConnector({ id: "pg-shared-id", tenant_id: tenantB });
    const poolA = await getPoolForConnector(forA, ctx.db);
    const poolB = await getPoolForConnector(forB, ctx.db);
    expect(poolA).not.toBe(poolB);
    await closePoolForConnector(forA);
    expect(await getPoolForConnector(forB, ctx.db)).toBe(poolB);
    expect(await getPoolForConnector(forA, ctx.db)).not.toBe(poolA);
  });

  test("a pool error is logged with the connector id instead of crashing", async () => {
    const errors: Array<Record<string, unknown>> = [];
    const spy = spyOn(logger, "error").mockImplementation((entry: unknown) => {
      errors.push(entry as Record<string, unknown>);
    });
    try {
      const connector = pgConnector();
      const pool = await getPoolForConnector(connector, ctx.db);
      pool.emit("error", new Error("idle client lost"));
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        module: "connectors",
        action: "pg.pool.error",
        connector_id: connector.id,
      });
    } finally {
      spy.mockRestore();
    }
  });

  test("opening a second connector keeps the first connector's pool", async () => {
    const first = pgConnector();
    const pool = await getPoolForConnector(first, ctx.db);
    await getPoolForConnector(pgConnector(), ctx.db);
    expect(await getPoolForConnector(first, ctx.db)).toBe(pool);
  });

  test("switching a DSN back opens a fresh pool instead of the retired one", async () => {
    const connector = pgConnector();
    const original = await getPoolForConnector(connector, ctx.db);
    await getPoolForConnector({ ...connector, dsn: `${ctx.url}?application_name=other` }, ctx.db);
    expect(await getPoolForConnector(connector, ctx.db)).not.toBe(original);
  });
});

describe("postgres failure cleanup", () => {
  test("a query against a connector without a DSN is refused", async () => {
    await expect(
      pgQueryWithCount({ exec: ctx.db, connector: pgConnector({ dsn: null }), sql: "SELECT 1" }),
    ).rejects.toThrow("Postgres connector has no dsn");
  });

  test("a failed cursor rolls back so the pooled connection stays usable", async () => {
    const connector = pgConnector();
    for (let i = 0; i < 6; i++) {
      await expect(
        pgQueryCursor({ exec: ctx.db, connector, sql: "SELECT 1/0", fetch_size: 5 }),
      ).rejects.toThrow();
    }
    const res = await pgQueryWithCount<{ ok: number }>({
      exec: ctx.db,
      connector,
      sql: "SELECT 1 AS ok",
    });
    expect(res.rows).toEqual([{ ok: 1 }]);
  });

  test("a failed transaction rolls back so the pooled connection stays usable", async () => {
    const connector = pgConnector();
    for (let i = 0; i < 6; i++) {
      await expect(
        pgTransaction({ exec: ctx.db, connector, statements: [{ query: "SELECT 1/0" }] }),
      ).rejects.toThrow();
    }
    const res = await pgQueryWithCount<{ ok: number }>({
      exec: ctx.db,
      connector,
      sql: "SELECT 1 AS ok",
    });
    expect(res.rows).toEqual([{ ok: 1 }]);
  });

  test("probe latency is measured from the start of the probe", async () => {
    const ok = await probePgConnector(pgConnector(), ctx.db);
    const bad = new URL(ctx.url);
    bad.password = "wrong-password";
    const failed = await probePgConnector(pgConnector({ dsn: bad.toString() }), ctx.db);
    expect(ok.ok).toBe(true);
    expect(ok.latency_ms).toBeGreaterThanOrEqual(0);
    expect(ok.latency_ms).toBeLessThan(60_000);
    expect(failed.ok).toBe(false);
    expect(failed.latency_ms).toBeGreaterThanOrEqual(0);
    expect(failed.latency_ms).toBeLessThan(60_000);
  });
});

describe("postgres connector pool limits", () => {
  test("every session of a connector pool carries the server-side statement deadline", async () => {
    const connector = pgConnector();
    const pool = await getPoolForConnector(connector, ctx.db);
    const shown = await pool.query<{ statement_timeout: string }>("SHOW statement_timeout");
    expect(shown.rows[0]?.statement_timeout).toBe(`${CONNECTOR_STATEMENT_TIMEOUT_MS / 1000}s`);
    expect(pool.options.connectionTimeoutMillis).toBe(CONNECTOR_CONNECT_TIMEOUT_MS);
  });
});
