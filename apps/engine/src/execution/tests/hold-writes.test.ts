import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { closeAllPools } from "../../connectors/drivers/postgres.ts";
import { connectors, executionSteps } from "../../db/schema/index.ts";
import { runExecution } from "../engine.ts";
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

  await ctx.testDb.db
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
  await ctx.testDb.pool.query(
    "CREATE TABLE IF NOT EXISTS public.hold_widgets (id int PRIMARY KEY, name text NOT NULL)",
  );

  await ctx.testDb.db
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
});

afterAll(async () => {
  await closeAllPools();
  await mock.close();
  await ctx.cleanup();
});

describe("hold-writes · HTTP", () => {
  test("child preview warnings survive the parent call without dispatching writes", async () => {
    hits.length = 0;
    const child = await createWorkflowRow(ctx, {
      name: "held-child-warning",
      steps: [{ kind: "request", id: "send", method: "POST", url: `${mock.baseUrl}/child-send` }],
    });
    const parent = await createWorkflowRow(ctx, {
      name: "held-parent-warning",
      steps: [
        { kind: "call", id: "call_child", workflow_id: child.workflow_id },
        {
          kind: "request",
          id: "read_created",
          method: "GET",
          url: `${mock.baseUrl}/created/\${scope.call_child.data.output.id}`,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: parent.workflow_id },
      input: null,
      options: { hold_writes: true },
    });
    expect(result.status).toBe("succeeded");
    expect(hitsFor("/child-send")).toHaveLength(0);
    expect(hitsFor("/created/")).toHaveLength(0);
    expect(result.steps.find((step) => step.step_key === "read_created")?.status).toBe("skipped");
    expect(result.warnings).toContainEqual(
      expect.objectContaining({
        code: "held_preview_no_writes",
        step_key: "call_child",
      }),
    );
    const rows = await ctx.testDb.db
      .select()
      .from(executionSteps)
      .where(eq(executionSteps.execution_id, result.execution_id));
    expect(JSON.stringify(rows[0]?.output_preview)).toContain("held_preview_no_writes");
  });

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
    expect(held.body).toEqual({ to: "user@example.com", subject: "Welcome" });
    expect(held.headers_redacted.Authorization).toBe("***REDACTED:auth_header***");
    expect(held.headers_redacted["X-Trace-Id"]).toBe("trace-1");

    const confirmStep = result.steps.find((s) => s.step_key === "confirm");
    expect(confirmStep?.status).toBe("skipped");
    expect((confirmStep!.error as { code?: string })?.code).toBe("skipped_dependency_held");
    expect((confirmStep!.error as { message?: string })?.message).toContain(
      'depends on held step "send"',
    );

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
    const codes = (result.warnings ?? []).map((w) => (w as { code?: string }).code);
    expect(codes).not.toContain("output_contract_violation");
  });

  test("author labels can escalate a read but cannot authorize a POST during preview", async () => {
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
    expect(hitsFor("/search")).toHaveLength(0);
    expect(result.steps.find((s) => s.step_key === "search")?.held).toBe(true);
    expect(hitsFor("/mutating-get")).toHaveLength(0);
    const heldStep = result.steps.find((s) => s.step_key === "mutating_get");
    expect(heldStep?.held).toBe(true);
    expect((heldStep!.held_request as HeldRequest).method).toBe("GET");
  });

  test("for_each steps hold per iteration — each iteration materializes its own held_request", async () => {
    hits.length = 0;
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "hold-loop",
      steps: [
        { kind: "request", id: "fetch", method: "GET", url: `${mock.baseUrl}/data` },
        {
          kind: "request",
          id: "notify",
          for_each: "(sourceData) => sourceData.fetch.data.ids",
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
    expect(hitsFor("/notify")).toHaveLength(0);

    const loopStep = result.steps.find((s) => s.step_key === "notify");
    expect(loopStep?.status).toBe("succeeded");
    const iterations = loopStep?.output_preview as Array<{
      notify: { held?: boolean; held_request?: HeldRequest };
    }>;
    expect(Array.isArray(iterations)).toBe(true);
    expect(iterations).toHaveLength(2);
    for (const [idx, iter] of iterations.entries()) {
      expect(iter.notify.held).toBe(true);
      expect(iter.notify.held_request?.method).toBe("POST");
      expect(iter.notify.held_request?.body).toEqual({ id: idx + 1 });
    }
    const warningCodes = (result.warnings ?? []).map((w) => w.code);
    expect(warningCodes).not.toContain("loop_body_empty");
  });

  test("held preview fails request_body_schema_violation exactly like the live run", async () => {
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

    for (const result of [held, live]) {
      expect(result.status).toBe("failed");
      const sendStep = result.steps.find((s) => s.step_key === "send");
      expect(sendStep?.status).toBe("failed");
      expect(sendStep?.held).toBeUndefined();
      expect((sendStep!.error as { code?: string })?.code).toBe("request_body_schema_violation");
      expect((sendStep!.error as { message?: string })?.message).toContain("subject");
    }
    expect(hitsFor("/send")).toHaveLength(0);
  });
});
