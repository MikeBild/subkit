import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { closeAllPools } from "../../connectors/drivers/postgres.ts";
import { connectors } from "../../db/schema/index.ts";
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
