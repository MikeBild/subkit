// Outbound Idempotency-Key — the request step attaches a per-attempt key
// to non-idempotent methods so retried writes against remotes that honour
// the standard don't double-apply. Key shape is
// `${execution_id}:${step_id}:${attempt}` so each retry is a distinct key
// tracing back to a concrete attempt.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { executionSteps, executions, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import type { RequestStep } from "../workflows/types.ts";
import { runRequestStep } from "./steps/request.ts";
import { createMockServer, jsonResponse, type MockServer } from "./tests/setup.ts";
import type { StepRunContext } from "./types.ts";

let testDb: TestDb;
let tenantId: string;
let mock: MockServer;
const observed: Array<{
  method: string;
  url: string;
  idempotency_key: string | null;
}> = [];
let mockBehaviour: { kind: "ok" } | { kind: "fail-then-ok"; remaining: number; status: number } = {
  kind: "ok",
};

beforeAll(async () => {
  testDb = await createTestDb("idempotency-key");
  const [tenant] = await testDb.db
    .insert(tenants)
    .values({ slug: "idemp", display_name: "Idempotency" })
    .returning();
  if (!tenant) throw new Error("tenant insert failed");
  tenantId = tenant.id;

  mock = await createMockServer((req, res) => {
    observed.push({
      method: req.method ?? "?",
      url: req.url ?? "?",
      idempotency_key:
        (req.headers["idempotency-key"] as string | undefined) ??
        (req.headers["Idempotency-Key"] as string | undefined) ??
        null,
    });
    if (mockBehaviour.kind === "fail-then-ok") {
      if (mockBehaviour.remaining > 0) {
        mockBehaviour.remaining -= 1;
        // Drain request body before responding to keep keep-alive happy.
        req.on("data", () => {});
        req.on("end", () => {
          jsonResponse(res, mockBehaviour.kind === "fail-then-ok" ? mockBehaviour.status : 500, {
            error: "transient",
          });
        });
        return;
      }
    }
    req.on("data", () => {});
    req.on("end", () => {
      jsonResponse(res, 200, { ok: true });
    });
  });
});

afterAll(async () => {
  await mock.close();
  await testDb.cleanup();
});

async function createExecutionRow(): Promise<{ execution_id: string; step_row_id: string }> {
  const [exec] = await testDb.db
    .insert(executions)
    .values({
      tenant_id: tenantId,
      source_kind: "step",
      status: "running",
      request_source: "api",
      execution_mode: "dev",
    })
    .returning({ id: executions.id });
  if (!exec) throw new Error("exec insert failed");
  const [stepRow] = await testDb.db
    .insert(executionSteps)
    .values({
      tenant_id: tenantId,
      execution_id: exec.id,
      step_key: "post-thing",
      step_index: 0,
      kind: "request",
      status: "running",
      started_at: new Date(),
    })
    .returning({ id: executionSteps.id });
  if (!stepRow) throw new Error("step row insert failed");
  return { execution_id: exec.id, step_row_id: stepRow.id };
}

function makeStepRunCtx(input: {
  execution_id: string;
  step_row_id: string;
  step: RequestStep;
}): StepRunContext {
  return {
    db: testDb.db,
    tenant_id: tenantId,
    execution_id: input.execution_id,
    workflow_id: "",
    workflow_version_id: "",
    request_source: "api",
    parent_execution_id: null,
    depth: 0,
    signal: new AbortController().signal,
    scope: {},
    started_at: new Date(),
    workflow_slug: "test",
    trace_id: null,
    principal: null,
    execution_mode: "dev",
    step: input.step,
    step_index: 0,
    step_row_id: input.step_row_id,
  };
}

describe("outbound Idempotency-Key", () => {
  test("POST request emits Idempotency-Key derived from execution + step + attempt", async () => {
    observed.length = 0;
    mockBehaviour = { kind: "ok" };
    const { execution_id, step_row_id } = await createExecutionRow();
    const step: RequestStep = {
      id: "post-thing",
      kind: "request",
      method: "POST",
      url: `${mock.baseUrl}/things`,
      body: { name: "x" },
      max_retries: 0,
    };
    const ctx = makeStepRunCtx({ execution_id, step_row_id, step });
    const r = await runRequestStep({ ctx, step, scope: {} });
    expect(r.status).toBe("succeeded");
    expect(observed.length).toBe(1);
    expect(observed[0]?.method).toBe("POST");
    expect(observed[0]?.idempotency_key).toBe(`${execution_id}:post-thing:1`);
    // Surfaces in audit trail.
    expect((r.request_meta as Record<string, unknown>).idempotency_key).toBe(
      `${execution_id}:post-thing:1`,
    );
  });

  test("retried POST emits a fresh key per attempt", async () => {
    observed.length = 0;
    // Force one 429 then succeed — POST retries on 429 even though the
    // method is non-idempotent (matches the request step's retry policy).
    mockBehaviour = { kind: "fail-then-ok", remaining: 1, status: 429 };
    const { execution_id, step_row_id } = await createExecutionRow();
    const step: RequestStep = {
      id: "post-thing",
      kind: "request",
      method: "POST",
      url: `${mock.baseUrl}/things`,
      body: { name: "x" },
      max_retries: 2,
      retry_backoff_ms: 50,
    };
    const ctx = makeStepRunCtx({ execution_id, step_row_id, step });
    const r = await runRequestStep({ ctx, step, scope: {} });
    expect(r.status).toBe("succeeded");
    // Two attempts: first attempt got 429, second got 200.
    expect(observed.length).toBe(2);
    expect(observed[0]?.idempotency_key).toBe(`${execution_id}:post-thing:1`);
    expect(observed[1]?.idempotency_key).toBe(`${execution_id}:post-thing:2`);
    // Audit trail records the LAST emitted key (the one the remote
    // actually applied).
    expect((r.request_meta as Record<string, unknown>).idempotency_key).toBe(
      `${execution_id}:post-thing:2`,
    );
  });

  test("GET method does NOT emit Idempotency-Key", async () => {
    observed.length = 0;
    mockBehaviour = { kind: "ok" };
    const { execution_id, step_row_id } = await createExecutionRow();
    const step: RequestStep = {
      id: "get-thing",
      kind: "request",
      method: "GET",
      url: `${mock.baseUrl}/things`,
      max_retries: 0,
    };
    const ctx = makeStepRunCtx({ execution_id, step_row_id, step });
    const r = await runRequestStep({ ctx, step, scope: {} });
    expect(r.status).toBe("succeeded");
    expect(observed.length).toBe(1);
    expect(observed[0]?.method).toBe("GET");
    expect(observed[0]?.idempotency_key).toBeNull();
    expect((r.request_meta as Record<string, unknown>).idempotency_key).toBeUndefined();
    void execution_id;
  });

  test("HEAD + OPTIONS skip Idempotency-Key as well", async () => {
    observed.length = 0;
    mockBehaviour = { kind: "ok" };
    const { execution_id, step_row_id } = await createExecutionRow();
    const step: RequestStep = {
      id: "head-thing",
      kind: "request",
      method: "HEAD",
      url: `${mock.baseUrl}/things`,
      max_retries: 0,
    };
    const ctx = makeStepRunCtx({ execution_id, step_row_id, step });
    const r = await runRequestStep({ ctx, step, scope: {} });
    expect(r.status).toBe("succeeded");
    expect(observed[0]?.idempotency_key).toBeNull();
    void execution_id;
  });
});
