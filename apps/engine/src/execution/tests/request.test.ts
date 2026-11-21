import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { events, executionSteps, executions } from "../../db/schema/index.ts";
import { runExecution } from "../engine.ts";
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

beforeAll(async () => {
  ctx = await createEngineCtx("request");
  mock = await createMockServer((_, res) => jsonResponse(res, 200, { ok: true, value: 42 }));
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

describe("request step", () => {
  test("runs a one-step request and persists rows + outbox event", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "one-shot",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: `${mock.baseUrl}/data`,
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
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.status).toBe("succeeded");
    expect(result.output).toEqual({ ok: true, value: 42 });

    const execRows = await ctx.testDb.db
      .select()
      .from(executions)
      .where(eq(executions.id, result.execution_id));
    expect(execRows[0]?.status).toBe("succeeded");

    const stepRows = await ctx.testDb.db
      .select()
      .from(executionSteps)
      .where(eq(executionSteps.execution_id, result.execution_id));
    expect(stepRows).toHaveLength(1);
    expect(stepRows[0]?.kind).toBe("request");
    expect(stepRows[0]?.status).toBe("succeeded");
    expect(stepRows[0]?.duration_ms).not.toBeNull();
    expect(stepRows[0]?.retry_count).toBe(0);

    const outboxRows = await ctx.testDb.db
      .select()
      .from(events)
      .where(eq(events.tenant_id, ctx.tenantId));
    const types = outboxRows.map((r) => r.type);
    expect(types).toContain("execution.queued");
    expect(types).toContain("execution.started");
    expect(types).toContain("execution.succeeded");
  });

  test("failed step records non-empty request_meta (url, method, header_keys, body_kind)", async () => {
    mock.setHandler((_, res) => jsonResponse(res, 404, { error: "not found" }));

    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "one-shot-404",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: `${mock.baseUrl}/missing`,
          expected_statuses: [200],
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

    const stepRows = await ctx.testDb.db
      .select()
      .from(executionSteps)
      .where(eq(executionSteps.execution_id, result.execution_id));
    expect(stepRows).toHaveLength(1);
    const meta = stepRows[0]?.output_preview as Record<string, unknown> | null;
    const rm =
      (stepRows[0] as unknown as { request_meta?: Record<string, unknown> }).request_meta ??
      (meta && typeof meta === "object" && "request" in meta
        ? (meta.request as Record<string, unknown>)
        : null) ??
      null;
    expect(rm).toBeTruthy();
    expect(typeof (rm as Record<string, unknown>).url).toBe("string");
    expect(String((rm as Record<string, unknown>).url)).toContain(`${mock.baseUrl}/missing`);
    expect((rm as Record<string, unknown>).method).toBe("GET");
    const digest = (rm as Record<string, unknown>).digest as Record<string, unknown> | undefined;
    expect(Array.isArray(digest?.header_keys)).toBe(true);
  });

  test("returns an explicitly expected 409 response to downstream steps", async () => {
    mock.setHandler((_, res) =>
      jsonResponse(res, 409, { code: "already_ingested", source_id: "source-1" }),
    );

    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "expected-conflict",
      steps: [
        {
          kind: "request",
          id: "ingest",
          method: "POST",
          url: `${mock.baseUrl}/ingest`,
          expected_statuses: [202, 409],
          max_retries: 0,
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
    expect(result.steps[0]?.status).toBe("succeeded");
    expect(result.output).toEqual({ code: "already_ingested", source_id: "source-1" });
  });

  test("setup failure (placeholder_unresolved) records request_meta.unresolved_placeholders", async () => {
    const wirePaths: string[] = [];
    mock.setHandler((req, res) => {
      wirePaths.push(req.url ?? "");
      jsonResponse(res, 200, { ok: true, value: 42 });
    });
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "one-shot-bad-placeholder",
      steps: [
        {
          kind: "request",
          id: "fetch",
          method: "GET",
          url: `${mock.baseUrl}/items/\${item.does_not_exist}`,
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

    const stepRows = await ctx.testDb.db
      .select()
      .from(executionSteps)
      .where(eq(executionSteps.execution_id, result.execution_id));
    const row = stepRows[0];
    expect(row?.status).toBe("failed");
    const errorObj = row?.error as { code?: string } | null;
    expect(errorObj?.code).toBe("placeholder_unresolved");
    expect(wirePaths).toEqual([]);
  });

  // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder is the fixture under test.
  test("request body preserves native JSON types — whole-value ${ref} leaves stay number/array/object on the wire", async () => {
    let captured: Record<string, unknown> | null = null;
    mock.setHandler(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      captured = raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : null;
      jsonResponse(res, 200, { ok: true });
    });

    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "typed-body",
      steps: [
        {
          kind: "request",
          id: "post",
          method: "POST",
          url: `${mock.baseUrl}/ingest`,
          body: {
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder is the fixture under test.
            limit: "${input.limit}",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder is the fixture under test.
            children: "${input.children}",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder is the fixture under test.
            filter: "${input.filter}",
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal ${...} placeholder is the fixture under test.
            note: "count=${input.limit}",
          },
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: {
        limit: 7,
        children: [{ a: 1 }, { b: 2 }],
        filter: { id: { eq: "x" } },
      },
    });
    expect(result.status).toBe("succeeded");
    const body = captured as Record<string, unknown> | null;
    expect(body).toBeTruthy();
    expect(typeof body?.limit).toBe("number");
    expect(body?.limit).toBe(7);
    expect(Array.isArray(body?.children)).toBe(true);
    expect(body?.children).toEqual([{ a: 1 }, { b: 2 }]);
    expect(body?.filter).toEqual({ id: { eq: "x" } });
    expect(body?.note).toBe("count=7");
  });
});
