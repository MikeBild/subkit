/* eslint-disable no-template-curly-in-string -- literal `${...}` placeholder tokens are part of the tested grammar. */
// Postgres workflow-step support — request steps with a `sql` block on
// a `driver: "postgres"` connector route through pgQueryWithCount, returning the
// row array as the envelope's `data`, with the safety that `sql.params`
// is the only injection-safe path for variable values.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { closeAllPools } from "../../connectors/drivers/postgres.ts";
import { connectors } from "../../db/schema/index.ts";
import { runExecution } from "../engine.ts";
import { createEngineCtx, createWorkflowRow, type EngineTestCtx } from "./setup.ts";

let ctx: EngineTestCtx;
let pgConnectorId: string;

beforeAll(async () => {
  ctx = await createEngineCtx("postgres-step");
  // Seed a postgres connector pointing at the same test database the
  // engine harness already provisioned. Reusing the test DB keeps the
  // fixture self-contained — no second container, no second migration.
  const [c] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "pg-step",
      display_name: "PG step",
      driver: "postgres",
      environment: "dev",
      auth_type: "none",
      base_url: ctx.testDb.url,
      dsn: ctx.testDb.url,
      config: {},
    })
    .returning();
  pgConnectorId = c!.id;
  // Seed a tiny table the workflow can SELECT from.
  await ctx.testDb.pool.query(
    "CREATE TABLE IF NOT EXISTS pg_step_widgets (id int PRIMARY KEY, name text NOT NULL)",
  );
  await ctx.testDb.pool.query(
    "INSERT INTO pg_step_widgets (id, name) VALUES (1, 'alpha'), (2, 'beta') ON CONFLICT DO NOTHING",
  );
});

afterAll(async () => {
  await closeAllPools();
  await ctx.cleanup();
});

describe("request step · postgres connector dispatch", () => {
  test("SELECT returns rows as the envelope data", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "pg-select",
      steps: [
        {
          id: "list",
          kind: "request",
          method: "SELECT",
          connector_id: pgConnectorId,
          sql: { query: "SELECT id, name FROM pg_step_widgets ORDER BY id" },
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual([
      { id: 1, name: "alpha" },
      { id: 2, name: "beta" },
    ]);
  });

  test("parameterised SELECT binds values from sql.params", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "pg-param",
      steps: [
        {
          id: "find",
          kind: "request",
          method: "SELECT",
          connector_id: pgConnectorId,
          sql: {
            query: "SELECT id, name FROM pg_step_widgets WHERE name = $1",
            params: ["beta"],
          },
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual([{ id: 2, name: "beta" }]);
  });

  test("input placeholder in sql.params resolves before bind", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "pg-input-placeholder",
      input_schema: {
        type: "object",
        properties: { wanted: { type: "string" } },
      },
      steps: [
        {
          id: "find",
          kind: "request",
          method: "SELECT",
          connector_id: pgConnectorId,
          sql: {
            query: "SELECT id FROM pg_step_widgets WHERE name = $1",
            params: ["${input.wanted}"],
          },
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: { wanted: "alpha" },
    });
    expect(result.status).toBe("succeeded");
    expect(result.output).toEqual([{ id: 1 }]);
  });

  test("sql.also wraps multiple statements in a transaction", async () => {
    await ctx.testDb.pool.query(
      "CREATE TABLE IF NOT EXISTS pg_step_balances (account text PRIMARY KEY, amount int NOT NULL)",
    );
    await ctx.testDb.pool.query(
      "INSERT INTO pg_step_balances (account, amount) VALUES ('a', 100), ('b', 0) ON CONFLICT (account) DO UPDATE SET amount = EXCLUDED.amount",
    );
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "pg-tx",
      steps: [
        {
          id: "transfer",
          kind: "request",
          method: "UPDATE",
          connector_id: pgConnectorId,
          sql: {
            query: "UPDATE pg_step_balances SET amount = amount - 25 WHERE account = $1",
            params: ["a"],
            also: [
              {
                query: "UPDATE pg_step_balances SET amount = amount + 25 WHERE account = $1",
                params: ["b"],
              },
            ],
          },
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    const final = await ctx.testDb.pool.query(
      "SELECT account, amount FROM pg_step_balances ORDER BY account",
    );
    expect(final.rows).toEqual([
      { account: "a", amount: 75 },
      { account: "b", amount: 25 },
    ]);
  });

  test("sql.also rolls back on a failing follow-up statement", async () => {
    await ctx.testDb.pool.query(
      "CREATE TABLE IF NOT EXISTS pg_step_uniq (id int PRIMARY KEY, label text NOT NULL UNIQUE)",
    );
    await ctx.testDb.pool.query(
      "INSERT INTO pg_step_uniq (id, label) VALUES (1, 'taken') ON CONFLICT DO NOTHING",
    );
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "pg-rollback",
      steps: [
        {
          id: "tx",
          kind: "request",
          method: "INSERT",
          connector_id: pgConnectorId,
          sql: {
            query: "INSERT INTO pg_step_uniq (id, label) VALUES (2, 'newly_added')",
            also: [
              {
                // Unique constraint violation — should rollback the
                // first insert.
                query: "INSERT INTO pg_step_uniq (id, label) VALUES (3, 'taken')",
              },
            ],
          },
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");
    const after = await ctx.testDb.pool.query(
      "SELECT count(*)::int AS n FROM pg_step_uniq WHERE label = 'newly_added'",
    );
    expect(after.rows[0]!.n).toBe(0);
  });

  test("sql.cursor streams rows via server-side cursor", async () => {
    await ctx.testDb.pool.query("CREATE TABLE IF NOT EXISTS pg_step_audit (id int PRIMARY KEY)");
    // Seed enough rows to span multiple cursor batches.
    await ctx.testDb.pool.query(
      "INSERT INTO pg_step_audit (id) SELECT i FROM generate_series(1, 25) AS i ON CONFLICT DO NOTHING",
    );
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "pg-cursor",
      steps: [
        {
          id: "stream",
          kind: "request",
          method: "SELECT",
          connector_id: pgConnectorId,
          sql: {
            query: "SELECT id FROM pg_step_audit ORDER BY id",
            cursor: { fetch_size: 10 },
          },
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("succeeded");
    expect(Array.isArray(result.output)).toBe(true);
    expect((result.output as unknown[]).length).toBe(25);
  });

  test("expected_row_count on UPDATE asserts row_count match", async () => {
    await ctx.testDb.pool.query(
      "CREATE TABLE IF NOT EXISTS pg_step_count (id int PRIMARY KEY, flag boolean NOT NULL)",
    );
    await ctx.testDb.pool.query(
      "INSERT INTO pg_step_count (id, flag) VALUES (1, false), (2, false) ON CONFLICT (id) DO UPDATE SET flag = false",
    );
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "pg-count-mismatch",
      steps: [
        {
          id: "flip",
          kind: "request",
          method: "UPDATE",
          connector_id: pgConnectorId,
          sql: {
            query: "UPDATE pg_step_count SET flag = true WHERE id = $1",
            params: [1],
          },
          expected_row_count: 99,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("expected_row_count_mismatch");
  });

  test("expected_row_count object form (max only) — at-most-N enforced", async () => {
    await ctx.testDb.pool.query("CREATE TABLE IF NOT EXISTS pg_step_atmost (id int PRIMARY KEY)");
    await ctx.testDb.pool.query(
      "INSERT INTO pg_step_atmost (id) SELECT i FROM generate_series(1, 5) AS i ON CONFLICT DO NOTHING",
    );
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "pg-atmost",
      steps: [
        {
          id: "purge",
          kind: "request",
          method: "DELETE",
          connector_id: pgConnectorId,
          sql: { query: "DELETE FROM pg_step_atmost" },
          expected_row_count: { max: 3 },
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("expected_row_count_mismatch");
    expect(result.error?.message).toContain("at most 3");
  });

  test("expected_row_count object form (min only) — at-least-N enforced", async () => {
    await ctx.testDb.pool.query("CREATE TABLE IF NOT EXISTS pg_step_atleast (id int PRIMARY KEY)");
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "pg-atleast",
      steps: [
        {
          id: "fetch",
          kind: "request",
          method: "SELECT",
          connector_id: pgConnectorId,
          sql: { query: "SELECT id FROM pg_step_atleast" },
          expected_row_count: { min: 1 },
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("expected_row_count_mismatch");
    expect(result.error?.message).toContain("at least 1");
  });

  test("sql.also[i].expected_row_count violation rolls back the transaction", async () => {
    await ctx.testDb.pool.query(
      "CREATE TABLE IF NOT EXISTS pg_step_per_stmt (id int PRIMARY KEY, val int NOT NULL)",
    );
    await ctx.testDb.pool.query(
      "INSERT INTO pg_step_per_stmt (id, val) VALUES (1, 0), (2, 0) ON CONFLICT (id) DO UPDATE SET val = 0",
    );
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "pg-per-stmt",
      steps: [
        {
          id: "tx",
          kind: "request",
          method: "UPDATE",
          connector_id: pgConnectorId,
          sql: {
            query: "UPDATE pg_step_per_stmt SET val = 7 WHERE id = $1",
            params: [1],
            // First statement OK (1 row updated, exact match).
            also: [
              {
                query: "UPDATE pg_step_per_stmt SET val = 9 WHERE id IN (1, 2)",
                // Second statement updates 2 rows but we assert exactly 999 — must roll back.
                expected_row_count: 999,
              },
            ],
          },
          expected_row_count: 1,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("expected_row_count_mismatch");
    // First statement's row write must have rolled back: val for id=1 stays 0.
    const after = await ctx.testDb.pool.query("SELECT val FROM pg_step_per_stmt WHERE id = 1");
    expect(after.rows[0]!.val).toBe(0);
  });

  test("missing sql block on a postgres connector trips sql_required_for_postgres", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "pg-missing-sql",
      steps: [
        {
          id: "no_sql",
          kind: "request",
          method: "GET",
          connector_id: pgConnectorId,
          path: "/ignored",
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("sql_required_for_postgres");
  });
});
