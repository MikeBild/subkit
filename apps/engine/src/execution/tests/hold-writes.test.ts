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
import { closeAllPools, getPoolForConnector } from "../../connectors/drivers/postgres.ts";
import { getConnector } from "../../connectors/index.ts";
import { connectors, executionSteps } from "../../db/schema/index.ts";
import { validateTenantWorkflowDef } from "../../workflows/tenant-validator.ts";
import type { RequestStep } from "../../workflows/types.ts";
import { runExecution } from "../engine.ts";
import { requestRequiresPreparationHold } from "../steps/request/side-effects.ts";
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

const hits: Array<{ method: string; url: string }> = [];
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

function hitsFor(path: string): Array<{ method: string; url: string }> {
  return hits.filter((h) => h.url.startsWith(path));
}

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

  test("a step is held to the boundary it declares, in preview exactly like live", async () => {
    hits.length = 0;
    const [site] = await ctx.testDb.db
      .insert(connectors)
      .values({
        tenant_id: ctx.tenantId,
        slug: "bounded-hold",
        display_name: "Bounded hold",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: `${mock.baseUrl}/api`,
        config: {},
      })
      .returning();
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "hold-declared-boundary",
      steps: [
        {
          kind: "request",
          id: "retire",
          connector_id: site!.id,
          method: "POST",
          side_effects: "write",
          path: "/sites/${input.site}/releases",
          body: { retire_item_ids: "${input.ids}" },
          boundary: {
            variables: { "input.site": { enum: ["reports"] } },
            max_body_bytes: 60,
            max_calls: 1,
          },
        },
      ],
    });
    const run = (input: Record<string, unknown>, hold: boolean) =>
      runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id },
        input,
        ...(hold ? { options: { hold_writes: true } } : {}),
      });
    const many = Array.from({ length: 12 }, (_, index) => `item-${index}`);
    for (const hold of [true, false]) {
      const oversize = await run({ site: "reports", ids: many }, hold);
      const step = oversize.steps.find((s) => s.step_key === "retire");
      expect(oversize.status).toBe("failed");
      expect(step?.held).toBeUndefined();
      expect((step?.error as { code?: string })?.code).toBe("request_outside_declared_boundary");
      const message = (step?.error as { message?: string })?.message ?? "";
      expect(message).toContain(
        `${Buffer.byteLength(JSON.stringify({ retire_item_ids: many }))} bytes`,
      );
      expect(message).toContain("`boundary.max_body_bytes` is 60");

      const elsewhere = await run({ site: "other", ids: ["a"] }, hold);
      const denied = elsewhere.steps.find((s) => s.step_key === "retire");
      expect((denied?.error as { code?: string })?.code).toBe("request_outside_declared_boundary");
      expect((denied?.error as { message?: string })?.message).toContain(
        "/api/sites/{input.site}/releases",
      );
      expect((denied?.error as { message?: string })?.message).toContain(
        "/api/sites/other/releases",
      );
    }
    expect(hitsFor("/api/sites/reports/releases")).toHaveLength(0);
    expect(hitsFor("/api/sites/other/releases")).toHaveLength(0);

    const { workflow_id: reader } = await createWorkflowRow(ctx, {
      name: "hold-declared-boundary-read",
      steps: [
        {
          kind: "request",
          id: "pending",
          connector_id: site!.id,
          method: "GET",
          path: "/spaces/${input.space}/proposals",
          query: { status: "pending" },
          boundary: {
            variables: { "input.space": { enum: ["wiki"] } },
            max_body_bytes: 0,
            max_calls: 1,
          },
        },
      ],
    });
    const read = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id: reader },
      input: { space: "wiki" },
      options: { hold_writes: true },
    });
    expect(read.status).toBe("succeeded");
    expect(hitsFor("/api/spaces/wiki/proposals?status=pending")).toHaveLength(1);

    const held = await run({ site: "reports", ids: ["a"] }, true);
    expect(held.steps.find((s) => s.step_key === "retire")?.held).toBe(true);
    expect(hitsFor("/api/sites/reports/releases")).toHaveLength(0);
    expect((await run({ site: "reports", ids: ["a"] }, false)).status).toBe("succeeded");
    expect(hitsFor("/api/sites/reports/releases")).toHaveLength(1);
  });

  test("a value class and a varying query value are held before anything is sent", async () => {
    hits.length = 0;
    const [api] = await ctx.testDb.db
      .insert(connectors)
      .values({
        tenant_id: ctx.tenantId,
        slug: "classed-hold",
        display_name: "Classed hold",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: `${mock.baseUrl}/api`,
        config: {},
      })
      .returning();
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "hold-declared-classes",
      steps: [
        {
          kind: "request",
          id: "stats",
          connector_id: api!.id,
          method: "GET",
          path: "/things/${input.id}/stats",
          query: { since: "${input.since}", tz: "UTC" },
          boundary: {
            variables: { "input.id": { class: "integer" }, "input.since": { class: "date" } },
            max_body_bytes: 0,
            max_calls: 1,
          },
        },
      ],
    });
    const run = (input: Record<string, unknown>) =>
      runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id },
        input,
      });
    expect((await run({ id: "42", since: "2026-09-01" })).status).toBe("succeeded");
    const [sent] = hitsFor("/api/things/42/stats?");
    expect(
      new URL(sent?.url ?? "", mock.baseUrl).searchParams.toString().split("&").sort(),
    ).toEqual(["since=2026-09-01", "tz=UTC"]);
    for (const input of [
      { id: "42/../admin", since: "2026-09-01" },
      { id: "007", since: "2026-09-01" },
      { id: "42", since: "2026-09-01&admin=1" },
      { id: "42", since: "yesterday" },
    ]) {
      const refused = await run(input);
      expect(refused.status).toBe("failed");
      expect(
        (refused.steps.find((s) => s.step_key === "stats")?.error as { code?: string })?.code,
      ).toBe("request_outside_declared_boundary");
    }
    expect(hitsFor("/api/")).toHaveLength(1);
  });

  test("a storage step is held to the folder it declares, in preview exactly like live", async () => {
    hits.length = 0;
    const [store] = await ctx.testDb.db
      .insert(connectors)
      .values({
        tenant_id: ctx.tenantId,
        slug: "scoped-hold",
        display_name: "Scoped hold",
        driver: "s3",
        environment: "dev",
        auth_type: "none",
        base_url: mock.baseUrl,
        config: {
          endpoint: mock.baseUrl,
          bucket: "reports",
          region: "us-east-1",
          force_path_style: true,
        },
      })
      .returning();
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "hold-declared-scope",
      steps: [
        {
          kind: "request",
          id: "store",
          connector_id: store!.id,
          method: "PUT",
          body: "${input.content}",
          s3: {
            key: "${input.key}",
            content_type: "text/plain",
            scope: { key_prefix: "v1/daily/", max_bytes: 20 },
          },
        },
      ],
    });
    const run = (input: Record<string, unknown>, hold: boolean) =>
      runExecution({
        db: ctx.testDb.db,
        tenant_id: ctx.tenantId,
        source: { kind: "saved", workflow_id },
        input,
        ...(hold ? { options: { hold_writes: true } } : {}),
      });
    for (const hold of [true, false]) {
      const elsewhere = await run({ key: "v1/weekly/a.txt", content: "ok" }, hold);
      const outside = elsewhere.steps.find((s) => s.step_key === "store");
      expect(elsewhere.status).toBe("failed");
      expect((outside?.error as { code?: string })?.code).toBe("request_outside_declared_boundary");
      expect((outside?.error as { message?: string })?.message).toContain('"v1/daily/"');
      expect((outside?.error as { message?: string })?.message).toContain('"v1/weekly/a.txt"');

      const oversize = await run({ key: "v1/daily/a.txt", content: "x".repeat(64) }, hold);
      const large = oversize.steps.find((s) => s.step_key === "store");
      expect((large?.error as { code?: string })?.code).toBe("request_outside_declared_boundary");
      expect((large?.error as { message?: string })?.message).toContain(
        "64 bytes but `s3.scope.max_bytes` is 20",
      );
    }
    expect(hitsFor("/reports/")).toHaveLength(0);

    const held = await run({ key: "v1/daily/a.txt", content: "ok" }, true);
    expect(held.steps.find((s) => s.step_key === "store")?.held).toBe(true);
    expect(hitsFor("/reports/")).toHaveLength(0);
    expect((await run({ key: "v1/daily/a.txt", content: "ok" }, false)).status).toBe("succeeded");
    expect(hitsFor("/reports/v1/daily/a.txt")).toHaveLength(1);
  });

  test("held_request.body deep-equals the body the live dispatch puts on the wire", async () => {
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
    const heldBody = (held.steps.find((s) => s.step_key === "send")!.held_request as HeldRequest)
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
          id: "count",
          method: "SELECT",
          connector_id: pgConnectorId,
          sql: { query: "SELECT count(*)::int AS n FROM public.hold_widgets" },
        },
        {
          kind: "request",
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
        id: "list",
        connector_id: http!.id,
        method: "GET",
        path: "/graphql",
        graphql: { operation: "query", query: "query List { things { id } }" },
      },
      {
        kind: "request",
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
      ({ kind: "request", id: "list", method: "GET", graphql: query, ...extra }) as RequestStep;
    expect(requestRequiresPreparationHold(step({ path: "/graphql" }))).toBe(false);
    expect(requestRequiresPreparationHold(step({ path: "/graphql" }), "http", base)).toBe(false);
    expect(requestRequiresPreparationHold(step({}), "http", base)).toBe(true);
    expect(requestRequiresPreparationHold(step({ path: "//evil.example/x" }), "http", base)).toBe(
      true,
    );
    expect(requestRequiresPreparationHold(step({ path: "/graphql" }), "postgres", base)).toBe(true);
    expect(
      requestRequiresPreparationHold(
        step({ path: "/graphql", graphql: { query: "mutation M { add { id } }" } }),
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
