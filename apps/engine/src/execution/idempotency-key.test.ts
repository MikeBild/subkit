import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { executionSteps, executions, tenants } from "../db/schema/index.ts";
import { createTestDb, type TestDb } from "../db/tests/setup.ts";
import { RunLlmBudget } from "../llm/accounting/index.ts";
import { getTestNow } from "../test-helpers/determinism/clock.ts";
import type { RequestStep } from "../workflows/types.ts";
import { runRequestStep } from "./steps/request.ts";
import { createMockServer, jsonResponse, type MockServer } from "./tests/setup.ts";
import type { StepRunContext } from "./types.ts";

const TEST_NOW_MS = getTestNow();

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
      started_at: new Date(TEST_NOW_MS),
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
    started_at: new Date(TEST_NOW_MS),
    workflow_slug: "test",
    trace_id: null,
    principal: null,
    execution_mode: "dev",
    step: input.step,
    step_index: 0,
    step_row_id: input.step_row_id,
    persist_workflow_refs: true,
    llm_budget: new RunLlmBudget(null),
  };
}

describe("outbound Idempotency-Key", () => {
  test("POST request emits Idempotency-Key derived from execution + step instance + page", async () => {
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
    expect(observed[0]?.idempotency_key).toBe(`${execution_id}:${step_row_id}:0`);
    expect((r.request_meta as Record<string, unknown>).idempotency_key).toBe(
      `${execution_id}:${step_row_id}:0`,
    );
  });

  test("retried POST reuses the same logical effect key", async () => {
    observed.length = 0;
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
    expect(observed.length).toBe(2);
    expect(observed[0]?.idempotency_key).toBe(`${execution_id}:${step_row_id}:0`);
    expect(observed[1]?.idempotency_key).toBe(observed[0]?.idempotency_key);
    expect((r.request_meta as Record<string, unknown>).idempotency_key).toBe(
      `${execution_id}:${step_row_id}:0`,
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
    expect(r.request_meta?.extras).toMatchObject({ effect_kind: "read" });
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
