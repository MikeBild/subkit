import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeAllPools, getPoolForConnector } from "../../connectors/drivers/postgres.ts";
import { getConnector } from "../../connectors/index.ts";
import { connectors } from "../../db/schema/index.ts";
import { validateTenantWorkflowDef } from "../../workflows/tenant-validator.ts";
import type { RequestStep } from "../../workflows/types.ts";
import { runExecution } from "../engine.ts";
import { requestRequiresPreparationHold } from "../steps/request/side-effects.ts";
import type { HeldRequest } from "../types.ts";
import { holdWritesFixtures } from "./hold-writes-fixtures.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  jsonResponse,
  type MockServer,
} from "./setup.ts";

let ctx: EngineTestCtx;

let mock: MockServer;

let pgConnectorId: string;

let gqlConnectorId: string;

const { hits, hitsFor } = holdWritesFixtures();

const wireBodies: Array<{ url: string; body: unknown }> = [];

beforeAll(async () => {
  ctx = await createEngineCtx("hold-writes");
  mock = await createMockServer(async (req, res) => {
    hits.push({ method: req.method ?? "", url: req.url ?? "" });
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (raw.length > 0) {
      try {
        wireBodies.push({ url: req.url ?? "", body: JSON.parse(raw) });
      } catch {
        wireBodies.push({ url: req.url ?? "", body: raw });
      }
    }
    if (req.url?.startsWith("/graphql")) {
      return jsonResponse(res, 200, { data: { things: [{ id: 1 }] } });
    }
    if (req.url?.startsWith("/data")) {
      return jsonResponse(res, 200, {
        email: "user@example.com",
        ids: [{ id: 1 }, { id: 2 }],
      });
    }
    return jsonResponse(res, 200, { ok: true });
  });

  const [pg] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "pg-hold",
      display_name: "PG hold",
      driver: "postgres",
      environment: "dev",
      auth_type: "none",
      base_url: ctx.testDb.url,
      dsn: ctx.testDb.url,
      config: {},
    })
    .returning();
  pgConnectorId = pg!.id;
  await ctx.testDb.pool.query(
    "CREATE TABLE IF NOT EXISTS public.hold_widgets (id int PRIMARY KEY, name text NOT NULL)",
  );

  const [gql] = await ctx.testDb.db
    .insert(connectors)
    .values({
      tenant_id: ctx.tenantId,
      slug: "gql-hold",
      display_name: "GQL hold",
      driver: "graphql",
      environment: "dev",
      auth_type: "none",
      base_url: `${mock.baseUrl}/graphql`,
      config: { endpoint: `${mock.baseUrl}/graphql` },
    })
    .returning();
  gqlConnectorId = gql!.id;
});

afterAll(async () => {
  await closeAllPools();
  await mock.close();
  await ctx.cleanup();
});

describe("hold-writes · postgres", () => {
  test("SELECT calling a writing function is held without touching the table", async () => {
    await ctx.testDb.pool.query(`
      CREATE FUNCTION public.hold_write_via_select() RETURNS integer LANGUAGE sql AS $$
        INSERT INTO public.hold_widgets (id, name) VALUES (101, 'function-effect') RETURNING id
      $$
    `);
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "hold-pg-writing-select",
      steps: [
        {
          kind: "request",
          protocol: "sql",
          id: "select_function",
          connector_id: pgConnectorId,
          side_effects: "read",
          sql: { query: "SELECT public.hold_write_via_select()" },
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
      options: { hold_writes: true },
    });
    expect(result.status).toBe("succeeded");
    expect(result.steps[0]?.held).toBe(true);
    const rows = await ctx.testDb.pool.query("SELECT id FROM public.hold_widgets WHERE id=101");
    expect(rows.rows).toHaveLength(0);
    const connector = await getConnector(ctx.tenantId, pgConnectorId, ctx.testDb.db);
    if (!connector) throw new Error("Postgres fixture connector missing");
    const client = await (await getPoolForConnector(connector, ctx.testDb.db)).connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT public.hold_write_via_select()");
      expect(
        (await client.query("SELECT id FROM public.hold_widgets WHERE id=101")).rows,
      ).toHaveLength(1);
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });

  test("a read label cannot dispatch a SQL insert during preview", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "hold-pg-mislabelled",
      steps: [
        {
          kind: "request",
          protocol: "sql",
          id: "insert",
          connector_id: pgConnectorId,
          side_effects: "read",
          sql: {
            query: "INSERT INTO public.hold_widgets (id, name) VALUES (99, 'not-authorized')",
          },
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
      options: { hold_writes: true },
    });
    expect(result.status).toBe("succeeded");
    expect(result.steps[0]?.held).toBe(true);
    const rows = await ctx.testDb.pool.query("SELECT id FROM public.hold_widgets WHERE id=99");
    expect(rows.rows).toHaveLength(0);
  });

  test("INSERT and unproven SELECT are held in the same preview", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "hold-pg",
      steps: [
        {
          kind: "request",
          protocol: "sql",
          id: "count",
          method: "SELECT",
          connector_id: pgConnectorId,
          sql: { query: "SELECT count(*)::int AS n FROM public.hold_widgets" },
        },
        {
          kind: "request",
          protocol: "sql",
          id: "ins",
          method: "INSERT",
          connector_id: pgConnectorId,
          sql: {
            query: "INSERT INTO public.hold_widgets (id, name) VALUES ($1, $2)",
            params: [7, "held"],
          },
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
      options: { hold_writes: true },
    });

    expect(result.status).toBe("succeeded");
    const countStep = result.steps.find((s) => s.step_key === "count");
    expect(countStep?.status).toBe("succeeded");
    expect(countStep?.held).toBe(true);
    expect(countStep?.output_preview).toBeNull();
    const insStep = result.steps.find((s) => s.step_key === "ins");
    expect(insStep?.held).toBe(true);
    const held = insStep?.held_request as HeldRequest;
    expect(held.url).toBeNull();
    expect(held.body).toEqual({
      query: "INSERT INTO public.hold_widgets (id, name) VALUES ($1, $2)",
      params: [7, "held"],
    });
    const rows = await ctx.testDb.pool.query("SELECT count(*)::int AS n FROM public.hold_widgets");
    expect(rows.rows[0]?.n).toBe(0);
  });
});

describe("hold-writes · graphql", () => {
  test("a graphql block on an http connector without path is refused before save and never dispatched", async () => {
    const [http] = await ctx.testDb.db
      .insert(connectors)
      .values({
        tenant_id: ctx.tenantId,
        slug: "http-gql-mismatch",
        display_name: "HTTP gql mismatch",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: mock.baseUrl,
        config: {},
      })
      .returning();
    const step = (connector_id: string) => ({
      kind: "request",
      protocol: "graphql",
      id: "project_items",
      connector_id,
      method: "GET",
      graphql: { operation: "query", query: "query Items { things { id } }" },
    });
    const refused = await validateTenantWorkflowDef(
      { name: "gql-on-http", steps: [step(http!.id)] },
      ctx.tenantId,
      ctx.testDb.db,
    );
    expect(refused.ok).toBe(false);
    expect(refused.errors.map((entry) => entry.path)).toContain("steps.project_items.graphql");
    const accepted = await validateTenantWorkflowDef(
      { name: "gql-on-gql", steps: [step(gqlConnectorId)] },
      ctx.tenantId,
      ctx.testDb.db,
    );
    expect(accepted.ok).toBe(true);

    hits.length = 0;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "gql-on-http-run",
      steps: [step(http!.id)],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    const items = result.steps.find((entry) => entry.step_key === "project_items");
    expect(items?.status).toBe("failed");
    expect((items?.error as { code?: string })?.code).toBe("graphql_path_required");
    expect(hits).toHaveLength(0);
  });

  test("path /graphql on an http connector runs a query live and holds a mutation", async () => {
    const [http] = await ctx.testDb.db
      .insert(connectors)
      .values({
        tenant_id: ctx.tenantId,
        slug: "http-gql-path",
        display_name: "HTTP gql path",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: mock.baseUrl,
        config: {},
      })
      .returning();
    const steps = [
      {
        kind: "request",
        protocol: "graphql",
        id: "list",
        connector_id: http!.id,
        method: "GET",
        path: "/graphql",
        graphql: { operation: "query", query: "query List { things { id } }" },
      },
      {
        kind: "request",
        protocol: "graphql",
        id: "add",
        connector_id: http!.id,
        path: "/graphql",
        side_effects: "read",
        graphql: {
          query: "mutation Add($name: String!) { add(name: $name) { id } }",
          variables: { name: "thing-1" },
        },
      },
    ];
    const validation = await validateTenantWorkflowDef(
      { name: "gql-path-on-http", steps },
      ctx.tenantId,
      ctx.testDb.db,
    );
    expect(validation.errors).toEqual([]);
    hits.length = 0;
    const { workflow_id } = await createWorkflowRow(ctx, { name: "hold-gql-path", steps });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
      options: { hold_writes: true },
    });
    expect(result.status).toBe("succeeded");
    expect(hitsFor("/graphql")).toEqual([{ method: "POST", url: "/graphql" }]);
    const list = result.steps.find((entry) => entry.step_key === "list");
    expect(list?.held).toBeUndefined();
    expect(list?.output_preview).toEqual({ things: [{ id: 1 }] });
    const add = result.steps.find((entry) => entry.step_key === "add");
    expect(add?.held).toBe(true);
    expect((add?.held_request as HeldRequest | undefined)?.url).toBe(`${mock.baseUrl}/graphql`);
  });

  test("the preparation hold accepts graphql on http only through a fixed path", () => {
    const base = "https://api.github.com";
    const query = { operation: "query" as const, query: "query List { things { id } }" };
    const step = (extra: Record<string, unknown>) =>
      ({
        kind: "request",
        protocol: "graphql",
        id: "list",
        method: "GET",
        graphql: query,
        ...extra,
      }) as RequestStep;
    expect(requestRequiresPreparationHold(step({ path: "/graphql" }))).toBe(false);
    expect(requestRequiresPreparationHold(step({ path: "/graphql" }), "http", base)).toBe(false);
    expect(requestRequiresPreparationHold(step({}), "http", base)).toBe(true);
    expect(requestRequiresPreparationHold(step({ path: "//evil.example/x" }), "http", base)).toBe(
      true,
    );
    expect(requestRequiresPreparationHold(step({ path: "/admin/cache/purge" }), "http", base)).toBe(
      true,
    );
    expect(requestRequiresPreparationHold(step({ path: "/graphql" }), "postgres", base)).toBe(true);
    expect(
      requestRequiresPreparationHold(
        step({
          protocol: "graphql",
          path: "/graphql",
          graphql: { query: "mutation M { add { id } }" },
        }),
        "http",
        base,
      ),
    ).toBe(true);
    expect(requestRequiresPreparationHold(step({ path: "/ignored" }), "graphql", base)).toBe(false);
  });

  test("query labels and read overrides cannot dispatch a mutation during preview", async () => {
    hits.length = 0;
    const queries = [
      "mutation Add { add { id } }",
      "fragment F on Thing { id } mutation Add { add { ...F } }",
      "query List { things { id } } mutation Add { add { id } }",
    ];
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "hold-gql-mislabelled",
      steps: queries.map((query, index) => ({
        kind: "request",
        protocol: "graphql",
        id: `unsafe${index}`,
        connector_id: gqlConnectorId,
        side_effects: "read",
        graphql: { operation: "query", query },
      })),
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
      options: { hold_writes: true },
    });
    expect(result.status).toBe("succeeded");
    expect(result.steps).toHaveLength(3);
    for (const step of result.steps) expect(step.held).toBe(true);
    expect(hitsFor("/graphql")).toHaveLength(0);
  });

  test("mutation is held with the resolved document; query executes live", async () => {
    hits.length = 0;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "hold-gql",
      steps: [
        {
          kind: "request",
          protocol: "graphql",
          id: "list",
          connector_id: gqlConnectorId,
          graphql: { query: "{ things { id } }" },
        },
        {
          kind: "request",
          protocol: "graphql",
          id: "add",
          connector_id: gqlConnectorId,
          graphql: {
            query: "mutation Add($name: String!) { add(name: $name) { id } }",
            variables: { name: "thing-1" },
          },
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
      options: { hold_writes: true },
    });

    expect(result.status).toBe("succeeded");
    expect(hitsFor("/graphql")).toHaveLength(1);

    const listStep = result.steps.find((s) => s.step_key === "list");
    expect(listStep?.status).toBe("succeeded");
    expect(listStep?.held).toBeUndefined();
    expect(listStep?.output_preview).toEqual({ things: [{ id: 1 }] });

    const addStep = result.steps.find((s) => s.step_key === "add");
    expect(addStep?.held).toBe(true);
    const held = addStep?.held_request as HeldRequest;
    expect(held.method).toBe("POST");
    expect(held.url).toBe(`${mock.baseUrl}/graphql`);
    expect(held.body).toEqual({
      query: "mutation Add($name: String!) { add(name: $name) { id } }",
      variables: { name: "thing-1" },
    });
  });
});
