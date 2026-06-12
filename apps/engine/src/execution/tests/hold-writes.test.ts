// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` placeholder tokens are part of the tested grammar.
//
// Fix G — hold-writes mode (`RunOptions.hold_writes`): side-effect-safe
// previews. Write-classified steps are fully RESOLVED (URL, headers,
// body materialized from real upstream data) but NEVER dispatched; the
// materialized request is recorded as `held_request` on the step
// summary. Read steps execute live. Dependents of a held step are
// skipped explicitly (`skipped_dependency_held`), loop bodies hold per
// iteration, and the default (no flag) behavior is byte-identical to
// before.
//
// The egress tripwire is the mock server's request log: a held write
// must leave ZERO entries for its path while sibling reads land.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { closeAllPools } from "../../connectors/drivers/postgres.ts";
import { connectors, executionSteps } from "../../db/schema/index.ts";
import { runExecution } from "../engine.ts";
import type { HeldRequest } from "../types.ts";
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

/** Every request the mock upstream actually received — the tripwire. */
const hits: Array<{ method: string; url: string }> = [];

beforeAll(async () => {
  ctx = await createEngineCtx("hold-writes");
  mock = await createMockServer((req, res) => {
    hits.push({ method: req.method ?? "", url: req.url ?? "" });
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

  // Postgres connector against the harness's own test database — the
  // strongest tripwire available for the SQL driver: a held INSERT must
  // leave the table physically empty.
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
    "CREATE TABLE IF NOT EXISTS hold_widgets (id int PRIMARY KEY, name text NOT NULL)",
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

function hitsFor(path: string): Array<{ method: string; url: string }> {
  return hits.filter((h) => h.url.startsWith(path));
}

describe("hold-writes · HTTP", () => {
  test("read executes live, write is held with the materialized request, dependent is skipped", async () => {
    hits.length = 0;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "hold-http",
      steps: [
        { kind: "request", id: "fetch", method: "GET", url: `${mock.baseUrl}/data` },
        {
          kind: "request",
          id: "send",
          method: "POST",
          url: `${mock.baseUrl}/send`,
          headers: {
            Authorization: "Bearer sk-test-secret-token-000",
            "X-Trace-Id": "trace-1",
          },
          body: { to: "${scope.fetch.data.email}", subject: "Welcome" },
        },
        { kind: "transform", id: "confirm", language: "jsonata", expression: "$scope.send.data" },
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

    // Egress tripwire: the read landed, the write NEVER hit the wire.
    expect(hitsFor("/data")).toHaveLength(1);
    expect(hitsFor("/send")).toHaveLength(0);

    const fetchStep = result.steps.find((s) => s.step_key === "fetch");
    expect(fetchStep?.status).toBe("succeeded");
    expect(fetchStep?.held).toBeUndefined();

    const sendStep = result.steps.find((s) => s.step_key === "send");
    expect(sendStep?.status).toBe("succeeded");
    expect(sendStep?.held).toBe(true);
    const held = sendStep?.held_request as HeldRequest;
    expect(held).toBeTruthy();
    expect(held.method).toBe("POST");
    expect(held.url).toBe(`${mock.baseUrl}/send`);
    // The artifact body is MATERIALIZED from real upstream data — the
    // placeholder substituted against the live GET response.
    expect(held.body).toEqual({ to: "user@example.com", subject: "Welcome" });
    // Secret-bearing headers are masked; names + safe values survive.
    expect(held.headers_redacted.Authorization).toBe("***REDACTED:auth_header***");
    expect(held.headers_redacted["X-Trace-Id"]).toBe("trace-1");

    // The dependent transform is skipped explicitly and labeled — not
    // failed with placeholder_unresolved.
    const confirmStep = result.steps.find((s) => s.step_key === "confirm");
    expect(confirmStep?.status).toBe("aborted");
    expect((confirmStep?.error as { code?: string })?.code).toBe("skipped_dependency_held");
    expect((confirmStep?.error as { message?: string })?.message).toContain(
      'depends on held step "send"',
    );

    // DB: the held step persisted as a succeeded row; the skipped
    // dependent never got a row (same contract as branch-arm skips).
    const stepRows = await ctx.testDb.db
      .select()
      .from(executionSteps)
      .where(eq(executionSteps.execution_id, result.execution_id));
    expect(stepRows.map((r) => r.step_key).sort()).toEqual(["fetch", "send"]);
    expect(stepRows.find((r) => r.step_key === "send")?.status).toBe("succeeded");
  });

  test("explicit side_effects override wins both directions at runtime", async () => {
    hits.length = 0;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "hold-override",
      steps: [
        {
          kind: "request",
          id: "search",
          method: "POST",
          url: `${mock.baseUrl}/search`,
          side_effects: "read",
          body: { q: "widgets" },
        },
        {
          kind: "request",
          id: "mutating_get",
          method: "GET",
          url: `${mock.baseUrl}/mutating-get`,
          side_effects: "write",
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
    // POST forced read → executed live.
    expect(hitsFor("/search")).toHaveLength(1);
    expect(result.steps.find((s) => s.step_key === "search")?.held).toBeUndefined();
    // GET forced write → held, never dispatched.
    expect(hitsFor("/mutating-get")).toHaveLength(0);
    const heldStep = result.steps.find((s) => s.step_key === "mutating_get");
    expect(heldStep?.held).toBe(true);
    expect((heldStep?.held_request as HeldRequest).method).toBe("GET");
  });

  test("loop bodies hold per iteration — each iteration materializes its own held_request", async () => {
    hits.length = 0;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "hold-loop",
      steps: [
        { kind: "request", id: "fetch", method: "GET", url: `${mock.baseUrl}/data` },
        { kind: "loop", id: "each", over: "$scope.fetch.data.ids", body: ["notify"] },
        {
          kind: "request",
          id: "notify",
          method: "POST",
          url: `${mock.baseUrl}/notify`,
          body: { id: "${item.id}" },
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
    expect(hitsFor("/data")).toHaveLength(1);
    // Tripwire: TWO iterations, ZERO dispatches.
    expect(hitsFor("/notify")).toHaveLength(0);

    const loopStep = result.steps.find((s) => s.step_key === "each");
    expect(loopStep?.status).toBe("succeeded");
    const iterations = loopStep?.output_preview as Array<{
      notify: { held?: boolean; held_request?: HeldRequest };
    }>;
    expect(Array.isArray(iterations)).toBe(true);
    expect(iterations).toHaveLength(2);
    for (const [idx, iter] of iterations.entries()) {
      expect(iter.notify.held).toBe(true);
      expect(iter.notify.held_request?.method).toBe("POST");
      // Per-iteration materialization: each artifact carries ITS item.
      expect(iter.notify.held_request?.body).toEqual({ id: String(idx + 1) });
    }
    // The hold-preview of an all-writes loop body must not trip the
    // empty-loop heuristic — held iterations are intentional.
    const warningCodes = (result.warnings ?? []).map((w) => w.code);
    expect(warningCodes).not.toContain("loop_body_empty");
  });

  test("default behavior unchanged — without the flag the write dispatches live", async () => {
    hits.length = 0;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "live-http",
      steps: [
        { kind: "request", id: "fetch", method: "GET", url: `${mock.baseUrl}/data` },
        {
          kind: "request",
          id: "send",
          method: "POST",
          url: `${mock.baseUrl}/send`,
          body: { to: "${scope.fetch.data.email}" },
        },
        { kind: "transform", id: "confirm", language: "jsonata", expression: "$scope.send.data" },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    expect(result.status).toBe("succeeded");
    expect(hitsFor("/send")).toHaveLength(1);
    const sendStep = result.steps.find((s) => s.step_key === "send");
    expect(sendStep?.held).toBeUndefined();
    expect(sendStep?.held_request).toBeUndefined();
    const confirmStep = result.steps.find((s) => s.step_key === "confirm");
    expect(confirmStep?.status).toBe("succeeded");
    expect(result.output).toEqual({ ok: true });
  });
});

describe("hold-writes · postgres", () => {
  test("INSERT is held (table stays empty); SELECT executes live in the same preview", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "hold-pg",
      steps: [
        {
          kind: "request",
          id: "count",
          method: "SELECT",
          connector_id: pgConnectorId,
          sql: { query: "SELECT count(*)::int AS n FROM hold_widgets" },
        },
        {
          kind: "request",
          id: "ins",
          method: "INSERT",
          connector_id: pgConnectorId,
          sql: {
            query: "INSERT INTO hold_widgets (id, name) VALUES ($1, $2)",
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
    // The read ran live against the real database…
    const countStep = result.steps.find((s) => s.step_key === "count");
    expect(countStep?.status).toBe("succeeded");
    expect(countStep?.held).toBeUndefined();
    expect(countStep?.output_preview).toEqual([{ n: 0 }]);
    // …while the write was held: artifact recorded, nothing executed.
    const insStep = result.steps.find((s) => s.step_key === "ins");
    expect(insStep?.held).toBe(true);
    const held = insStep?.held_request as HeldRequest;
    expect(held.url).toBeNull();
    expect(held.body).toEqual({
      query: "INSERT INTO hold_widgets (id, name) VALUES ($1, $2)",
      params: [7, "held"],
    });
    const rows = await ctx.testDb.pool.query("SELECT count(*)::int AS n FROM hold_widgets");
    expect(rows.rows[0]?.n).toBe(0);
  });
});

describe("hold-writes · graphql", () => {
  test("mutation is held with the resolved document; query executes live", async () => {
    hits.length = 0;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "hold-gql",
      steps: [
        {
          kind: "request",
          id: "list",
          connector_id: gqlConnectorId,
          graphql: { query: "{ things { id } }" },
        },
        {
          kind: "request",
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
    // Exactly ONE wire call — the query; the mutation never dispatched.
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
