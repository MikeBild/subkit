import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Db } from "../../db/client.ts";
import { createMockServer, jsonResponse, type MockServer } from "../../execution/tests/setup.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let target: Db | null = null;
let queryCount = 0;
const COUNTED = new Set(["select", "selectDistinct", "selectDistinctOn", "execute", "$count"]);
const countingDb = new Proxy({} as Db, {
  get(_t, prop) {
    if (!target) throw new Error("counting db used before the test db exists");
    const value = Reflect.get(target, prop, target) as unknown;
    if (prop === "query") queryCount += 1;
    if (typeof value !== "function") return value;
    return (...args: unknown[]) => {
      if (typeof prop === "string" && COUNTED.has(prop)) queryCount += 1;
      return (value as (...a: unknown[]) => unknown).apply(target, args);
    };
  },
});

let ctx: HttpTestServer;
let upstream: MockServer;

beforeAll(async () => {
  ctx = await createHttpTestServer("execution_outcome", { appOptions: { db: countingDb } });
  target = ctx.db;
  upstream = await createMockServer((req, res) => {
    if (req.url?.startsWith("/denied")) {
      jsonResponse(res, 401, { error: "unauthorized" });
      return;
    }
    jsonResponse(res, 200, { ok: true, value: 7 });
  });
});

afterAll(async () => {
  await upstream.close();
  await ctx.cleanup();
});

const auth = (): Record<string, string> => ({
  authorization: `Bearer ${ctx.apiKey}`,
  "content-type": "application/json",
});

interface Outcome {
  kind: string;
  failed_step: { step_key: string; kind: string } | null;
  cause_class: string | null;
  error_code: string | null;
  steps: { total: number; succeeded: number; failed: number; held: number; skipped: number };
  output_contract: string;
}

async function runDraft(
  definition: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const res = await fetch(`${ctx.baseUrl}/v1/executions`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ source: "draft", definition, ...extra }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { execution_id: string }).execution_id;
}

async function outcomeOf(id: string): Promise<Outcome> {
  const res = await fetch(`${ctx.baseUrl}/v1/executions/${id}`, { headers: auth() });
  expect(res.status).toBe(200);
  return ((await res.json()) as { outcome: Outcome }).outcome;
}

const read = (id: string, path: string) => ({
  id,
  kind: "request",
  method: "GET",
  url: `${upstream.baseUrl}${path}`,
});
const transform = (id: string, expression = "return { done: true };") => ({
  id,
  kind: "transform",
  language: "javascript",
  expression,
});

describe("execution outcome", () => {
  test("a run stopped by an auth error names the step and an auth cause", async () => {
    const id = await runDraft({
      name: "auth-fail",
      steps: [read("fetch", "/denied"), transform("after")],
    });
    const outcome = await outcomeOf(id);
    expect(outcome.kind).toBe("failed");
    expect(outcome.failed_step).toEqual({ step_key: "fetch", kind: "request" });
    expect(outcome.cause_class).toBe("auth_failed");
    expect(outcome.error_code).not.toBeNull();
    expect(outcome.steps.failed).toBe(1);
    expect(outcome.steps.succeeded).toBe(0);
  });

  test("a held preview is held, not succeeded", async () => {
    const id = await runDraft(
      {
        name: "held-preview",
        steps: [
          read("load", "/ok"),
          { id: "send", kind: "request", method: "POST", url: `${upstream.baseUrl}/send` },
        ],
      },
      { hold_writes: true },
    );
    const outcome = await outcomeOf(id);
    expect(outcome.kind).toBe("held");
    expect(outcome.steps.held).toBe(1);
    expect(outcome.steps.succeeded).toBe(1);
    expect(outcome.failed_step).toBeNull();
  });

  test("a succeeded run has no failed step and records its output contract", async () => {
    const passed = await outcomeOf(
      await runDraft({
        name: "contract-ok",
        steps: [transform("out", "return { total: 3 };")],
        output_schema: {
          type: "object",
          properties: { total: { type: "number" } },
          required: ["total"],
        },
      }),
    );
    expect(passed.kind).toBe("succeeded");
    expect(passed.failed_step).toBeNull();
    expect(passed.cause_class).toBeNull();
    expect(passed.output_contract).toBe("passed");

    const violated = await outcomeOf(
      await runDraft({
        name: "contract-broken",
        steps: [transform("out", "return { total: 'three' };")],
        output_schema: {
          type: "object",
          properties: { total: { type: "number" } },
          required: ["total"],
        },
      }),
    );
    expect(violated.kind).toBe("succeeded");
    expect(violated.output_contract).toBe("violated");

    const none = await outcomeOf(
      await runDraft({ name: "no-contract", steps: [transform("out")] }),
    );
    expect(none.output_contract).toBe("none");
  });

  test("a workflow-level failure has no failed step but keeps its code", async () => {
    const created = await fetch(`${ctx.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({
        name: "validation-fails",
        steps: [transform("out", "return { ok: false };")],
        validation_expression: "ok",
      }),
    });
    expect(created.status).toBe(201);
    const workflowId = ((await created.json()) as { id: string }).id;
    const run = await fetch(`${ctx.baseUrl}/v1/executions`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ source: "saved", workflow_id: workflowId }),
    });
    const runBody = (await run.json()) as { execution_id: string; status: string };
    expect(runBody.status).toBe("failed");
    const outcome = await outcomeOf(runBody.execution_id);
    expect(outcome.kind).toBe("failed");
    expect(outcome.failed_step).toBeNull();
    expect(outcome.error_code).toBe("validation_failed");
  });

  test("a tolerated step failure makes the run partial, not succeeded", async () => {
    const id = await runDraft({
      name: "tolerated",
      steps: [{ ...read("optional", "/denied"), on_error: "continue" }, transform("after")],
    });
    const outcome = await outcomeOf(id);
    expect(outcome.kind).toBe("partial");
    expect(outcome.failed_step?.step_key).toBe("optional");
    expect(outcome.steps.failed).toBe(1);
    expect(outcome.steps.succeeded).toBe(1);
  });
});

describe("execution list failure", () => {
  test("only failed runs carry a failure, in a constant number of queries", async () => {
    const created = await fetch(`${ctx.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: auth(),
      body: JSON.stringify({ name: "list-fail", steps: [read("fetch", "/denied")] }),
    });
    expect(created.status).toBe(201);
    const workflowId = ((await created.json()) as { id: string }).id;
    for (let i = 0; i < 12; i++) {
      const run = await fetch(`${ctx.baseUrl}/v1/executions`, {
        method: "POST",
        headers: auth(),
        body: JSON.stringify({ source: "saved", workflow_id: workflowId }),
      });
      expect(((await run.json()) as { status: string }).status).toBe("failed");
    }
    const okId = await runDraft({ name: "list-ok", steps: [transform("out")] });

    type Item = {
      id: string;
      status: string;
      failure: {
        step_key: string | null;
        cause_class: string | null;
        connector: { connector_id: string | null; reason: string } | null;
        refusal_reason: string | null;
      } | null;
    };
    const list = async (query: string) => {
      const res = await fetch(`${ctx.baseUrl}/v1/executions?${query}`, { headers: auth() });
      expect(res.status).toBe(200);
      return ((await res.json()) as { items: Item[] }).items;
    };

    const items = await list("limit=100");
    expect(items.find((i) => i.id === okId)?.failure).toBeNull();
    const failed = items.filter((i) => i.status === "failed");
    expect(failed.length).toBeGreaterThanOrEqual(12);
    for (const item of failed) expect(item.failure).not.toBeNull();
    for (const item of items.filter((i) => i.status !== "failed")) expect(item.failure).toBeNull();
    const own = await list(`workflow_id=${workflowId}&limit=50`);
    expect(own).toHaveLength(12);
    for (const item of own) {
      expect(item.failure).toEqual({
        step_key: "fetch",
        cause_class: "auth_failed",
        connector: null,
        refusal_reason: null,
      });
    }

    await list(`workflow_id=${workflowId}&limit=1`);
    queryCount = 0;
    await list(`workflow_id=${workflowId}&limit=2`);
    const forTwo = queryCount;
    queryCount = 0;
    await list(`workflow_id=${workflowId}&limit=50`);
    expect(forTwo).toBeGreaterThan(0);
    expect(queryCount).toBe(forTwo);
  });
});
