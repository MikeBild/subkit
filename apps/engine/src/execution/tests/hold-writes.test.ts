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
/** Raw wire bodies by path — the held-vs-live parity oracle. */
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
        {
          kind: "transform",
          id: "confirm",
          language: "javascript",
          expression: "return input.scope.send.data;",
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
    expect(confirmStep?.status).toBe("skipped");
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

  test("honest preview — a held write surfaces a mandatory held_preview_no_writes warning (gemeldet ≠ geschrieben)", async () => {
    hits.length = 0;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "hold-honest-preview",
      steps: [
        { kind: "request", id: "fetch", method: "GET", url: `${mock.baseUrl}/data` },
        {
          kind: "request",
          id: "send",
          method: "POST",
          url: `${mock.baseUrl}/send`,
          body: { to: "${scope.fetch.data.email}" },
        },
        {
          kind: "transform",
          id: "confirm",
          language: "javascript",
          expression: "return input.scope.send.data;",
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
    expect(hitsFor("/send")).toHaveLength(0);

    const warning = (result.warnings ?? []).find(
      (w) => (w as { code?: string }).code === "held_preview_no_writes",
    ) as { message?: string; step_key?: string; details?: Record<string, unknown> } | undefined;
    expect(warning).toBeTruthy();
    expect(warning?.step_key).toBe("$holds");
    expect(warning?.message).toContain("NOTHING was written");
    // The engine states the STATE, never the remedy: `execute_writes` is a
    // tool argument the surfaces own, not an execution-subsystem concept.
    expect(warning?.message).not.toContain("execute_writes");
    expect(warning?.details?.held_steps).toEqual(["send"]);
    expect(warning?.details?.skipped_steps).toEqual(["confirm"]);
    expect(warning?.details?.would_write).toEqual([
      { step: "send", method: "POST", url: `${mock.baseUrl}/send` },
    ]);
  });

  test("honest preview — a hold_writes run with NO writes emits no held_preview warning", async () => {
    hits.length = 0;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "hold-read-only",
      steps: [
        { kind: "request", id: "fetch", method: "GET", url: `${mock.baseUrl}/data` },
        {
          kind: "transform",
          id: "shape",
          language: "javascript",
          expression: "return input.scope.fetch.data;",
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
    const codes = (result.warnings ?? []).map((w) => (w as { code?: string }).code);
    expect(codes).not.toContain("held_preview_no_writes");
  });

  test("output_schema contract is SKIPPED when the output-producing chain was held (interplay regression)", async () => {
    // A send-terminated workflow with an output_schema (e.g. the Gmail
    // {id, threadId} contract) must not go permanently red under
    // hold-writes: the held terminal step leaves no live final output,
    // so validating it would block every preview of this shape.
    hits.length = 0;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "hold-output-contract",
      output_schema: {
        type: "object",
        required: ["id", "threadId"],
        properties: { id: { type: "string" }, threadId: { type: "string" } },
      },
      steps: [
        { kind: "request", id: "fetch", method: "GET", url: `${mock.baseUrl}/data` },
        {
          kind: "request",
          id: "send",
          method: "POST",
          url: `${mock.baseUrl}/send`,
          body: { to: "${scope.fetch.data.email}" },
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
    expect(hitsFor("/send")).toHaveLength(0);
    const sendStep = result.steps.find((s) => s.step_key === "send");
    expect(sendStep?.held).toBe(true);
    // The interplay regression: NO output_contract_violation warning —
    // the contract is a live-output assertion, skipped under holds.
    const codes = (result.warnings ?? []).map((w) => (w as { code?: string }).code);
    expect(codes).not.toContain("output_contract_violation");
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
      // The whole-value `"${item.id}"` body leaf preserves the native type
      // of the resolved value — the ids are numbers, so the materialized
      // body carries a number (type-preserving request-body resolution,
      // parity with GraphQL variables), not the legacy stringified "1".
      expect(iter.notify.held_request?.body).toEqual({ id: idx + 1 });
    }
    // The hold-preview of an all-writes loop body must not trip the
    // empty-loop heuristic — held iterations are intentional.
    const warningCodes = (result.warnings ?? []).map((w) => w.code);
    expect(warningCodes).not.toContain("loop_body_empty");
  });

  test("held preview fails request_body_schema_violation exactly like the live run", async () => {
    // Preview↔live parity: body-schema validation runs BEFORE the hold
    // return. A body the live run refuses to send must fail the preview
    // too — previously the step held green and the divergence only
    // surfaced when the user executed for real.
    hits.length = 0;
    const steps = [
      {
        kind: "request",
        id: "send",
        method: "POST",
        url: `${mock.baseUrl}/send`,
        body: { to: "user@example.com" },
        body_schema: {
          type: "object",
          required: ["to", "subject"],
          properties: { to: { type: "string" }, subject: { type: "string" } },
        },
      },
    ];
    const { workflow_id } = await createWorkflowRow(ctx, { name: "hold-schema-parity", steps });

    const held = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
      options: { hold_writes: true },
    });
    const live = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });

    // Identical failure shape in both modes; nothing ever hit the wire.
    for (const result of [held, live]) {
      expect(result.status).toBe("failed");
      const sendStep = result.steps.find((s) => s.step_key === "send");
      expect(sendStep?.status).toBe("failed");
      expect(sendStep?.held).toBeUndefined();
      expect((sendStep?.error as { code?: string })?.code).toBe("request_body_schema_violation");
      expect((sendStep?.error as { message?: string })?.message).toContain("subject");
    }
    expect(hitsFor("/send")).toHaveLength(0);
  });

  test("held_request.body deep-equals the body the live dispatch puts on the wire", async () => {
    // The held artifact claims "this is exactly what would be sent" —
    // pin that claim byte-for-byte against a live dispatch of the same
    // workflow (non-secret payload: heldStepResult scrubs secret-shaped
    // strings, so parity here is modulo scrubbing by construction).
    hits.length = 0;
    wireBodies.length = 0;
    const steps = [
      { kind: "request", id: "fetch", method: "GET", url: `${mock.baseUrl}/data` },
      {
        kind: "transform",
        id: "shape",
        language: "javascript",
        expression:
          "return { recipient: input.scope.fetch.data.email, items: input.scope.fetch.data.ids, note: 'parity' };",
      },
      {
        kind: "request",
        id: "send",
        method: "POST",
        url: `${mock.baseUrl}/parity-send`,
        body: {
          to: "${scope.shape.data.recipient}",
          payload: { items: "${scope.shape.data.items}", note: "${scope.shape.data.note}" },
          static_flag: true,
        },
      },
    ];
    const { workflow_id } = await createWorkflowRow(ctx, { name: "hold-body-parity", steps });

    const held = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
      options: { hold_writes: true },
    });
    expect(held.status).toBe("succeeded");
    expect(hitsFor("/parity-send")).toHaveLength(0);
    const heldBody = (held.steps.find((s) => s.step_key === "send")?.held_request as HeldRequest)
      .body;

    const live = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(live.status).toBe("succeeded");
    expect(hitsFor("/parity-send")).toHaveLength(1);
    const liveWireBody = wireBodies.find((b) => b.url.startsWith("/parity-send"))?.body;

    expect(liveWireBody).toBeDefined();
    expect(heldBody).toEqual(liveWireBody);
    // And the materialization is real (not the placeholder text).
    expect(heldBody).toEqual({
      to: "user@example.com",
      payload: { items: [{ id: 1 }, { id: 2 }], note: "parity" },
      static_flag: true,
    });
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
        {
          kind: "transform",
          id: "confirm",
          language: "javascript",
          expression: "return input.scope.send.data;",
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
