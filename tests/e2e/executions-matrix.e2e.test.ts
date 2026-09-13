// Execution matrix — every run surface, deterministic (no LLM).
//
// Covers the discriminated `source` union the engine accepts plus the
// stateless transform endpoint, driven over HTTP and the `sk executions`
// CLI. All steps are pure JS/JSONata transforms so runs are hermetic and
// fast — no connector reachability in the gating path. Async runs flow
// through `waitForExecution` (poll, never sleep). Asserts on the
// structured execution runtime logs (module=execution).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { defaultTransformSteps, seedWorkflow, waitForExecution } from "./_helpers/factories.ts";
import { apiClient } from "./_helpers/http.ts";
import { assertLogEvent } from "./_helpers/logs.ts";
import { boot, cli, type E2EEnv, expectSuccess, shutdown } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("executions-matrix", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
}, 30_000);

interface RunResponse {
  execution_id: string;
  status: string;
  output?: unknown;
}

describe("source: saved", () => {
  test("sync run returns a terminal status + transform output, and logs the execution", async () => {
    const api = apiClient(env);
    const { id } = await seedWorkflow(env, { description: "saved sync run" });

    const run = await api.post<RunResponse>("/v1/executions", {
      source: "saved",
      workflow_id: id,
      input: { hello: "world" },
      request_source: "api",
    });
    expect([200, 201]).toContain(run.status);
    expect(run.body.execution_id).toBeTruthy();
    const output = run.body.output as { ok?: boolean; value?: unknown } | undefined;
    // Default transform echoes the run input under `value`.
    expect(output?.ok).toBe(true);

    // The execution was recorded in the runtime log under module=execution.
    await assertLogEvent(api, {
      module: "execution",
      where: (e) => e.fields.execution_id === run.body.execution_id,
      wait: true,
    });

    // It is fetchable + listable.
    const got = await api.get<{ id: string; status: string }>(
      `/v1/executions/${run.body.execution_id}`,
    );
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(run.body.execution_id);

    const list = await api.get<{ items: Array<{ id: string }> }>(
      `/v1/executions?workflow_id=${id}&limit=10`,
    );
    expect(list.status).toBe(200);
    expect(list.body.items.some((e) => e.id === run.body.execution_id)).toBe(true);
  }, 60_000);

  test("async run accepts, then converges to terminal via polling", async () => {
    const api = apiClient(env);
    const { id } = await seedWorkflow(env, { description: "saved async run" });

    const run = await api.post<RunResponse>("/v1/executions", {
      source: "saved",
      workflow_id: id,
      input: { n: 1 },
      async: true,
    });
    expect([200, 201, 202]).toContain(run.status);
    expect(run.body.execution_id).toBeTruthy();

    const terminal = await waitForExecution(api, run.body.execution_id);
    expect(["completed", "succeeded"]).toContain(terminal.status);
  }, 60_000);

  test("rerun spawns a fresh execution of the same workflow", async () => {
    const api = apiClient(env);
    const { id } = await seedWorkflow(env, { description: "saved rerun" });
    const first = await api.post<RunResponse>("/v1/executions", {
      source: "saved",
      workflow_id: id,
      input: { seed: 1 },
    });
    expect([200, 201]).toContain(first.status);

    const rerun = await api.post<RunResponse>(
      `/v1/executions/${first.body.execution_id}/rerun`,
      {},
    );
    expect([200, 201, 202]).toContain(rerun.status);
    expect(rerun.body.execution_id).toBeTruthy();
    expect(rerun.body.execution_id).not.toBe(first.body.execution_id);
  }, 60_000);
});

describe("source: draft (inline definition, no persisted workflow)", () => {
  test("runs a draft definition without creating a workflow row", async () => {
    const api = apiClient(env);
    const run = await api.post<RunResponse>("/v1/executions", {
      source: "draft",
      name: "draft-inline",
      definition: { name: "draft-inline", steps: defaultTransformSteps() },
      input: { from: "draft" },
    });
    expect([200, 201]).toContain(run.status);
    const output = run.body.output as { ok?: boolean } | undefined;
    expect(output?.ok).toBe(true);

    // Draft runs carry a null workflow_id on the row.
    const got = await api.get<{ workflow_id: string | null; source_kind: string }>(
      `/v1/executions/${run.body.execution_id}`,
    );
    expect(got.body.source_kind).toBe("draft");
    expect(got.body.workflow_id).toBeNull();
  }, 60_000);
});

describe("source: step (single isolated step)", () => {
  test("runs a single transform step against supplied input", async () => {
    const api = apiClient(env);
    const run = await api.post<RunResponse>("/v1/executions", {
      source: "step",
      step: {
        id: "only",
        kind: "transform",
        language: "javascript",
        expression: "return { doubled: (input.input.n ?? 0) * 2 };",
      },
      input: { n: 21 },
    });
    expect([200, 201]).toContain(run.status);
    const output = run.body.output as { doubled?: number } | undefined;
    expect(output?.doubled).toBe(42);
  }, 60_000);
});

describe("stateless transform endpoint", () => {
  test("JSONata transform projects a field out of the payload", async () => {
    const api = apiClient(env);
    const res = await api.post<{ output: unknown; duration_ms: number }>(
      "/v1/executions/transform",
      {
        payload: { value: 7, noise: "drop" },
        output_transform: "value",
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.output).toBe(7);
    expect(typeof res.body.duration_ms).toBe("number");
  }, 30_000);
});

describe("sk executions CLI", () => {
  test("sk executions list returns rows after a run", async () => {
    const api = apiClient(env);
    const { id } = await seedWorkflow(env, { description: "cli executions" });
    await api.post<RunResponse>("/v1/executions", { source: "saved", workflow_id: id, input: {} });

    const result = await cli(["executions", "list"], { env, persona: "admin" });
    expectSuccess(result, "sk executions list");
  }, 60_000);
});
