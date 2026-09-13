import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { events } from "../../db/schema/index.ts";
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
  ctx = await createEngineCtx("onerror");
  mock = await createMockServer((req, res) => {
    if (req.url?.startsWith("/fail")) {
      jsonResponse(res, 404, { error: "not found" });
      return;
    }
    if (req.url?.startsWith("/boom")) {
      jsonResponse(res, 500, { error: "boom" });
      return;
    }
    if (req.url?.startsWith("/seraph")) {
      // Atlassian Seraph anonymous response: HTTP 200 + empty result set +
      // X-Seraph-LoginReason header. A dead credential must fail loudly here,
      // not transform an empty body as if it were real data.
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.setHeader("x-seraph-loginreason", "AUTHENTICATED_FAILED");
      res.end(JSON.stringify({ issues: [], isLast: true }));
      return;
    }
    jsonResponse(res, 200, { ok: true });
  });
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

describe("onError modes", () => {
  test("onError=fail aborts the rest of the pipeline", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "fail-mode",
      steps: [
        {
          kind: "request",
          id: "broken",
          method: "GET",
          url: `${mock.baseUrl}/fail/x`,
          max_retries: 0,
        },
        { kind: "request", id: "ok", method: "GET", url: `${mock.baseUrl}/ok` },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.status).toBe("failed");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[1]?.status).toBe("skipped");
  });

  test("Seraph anonymous-200 (dead credential) fails the step instead of succeeding empty", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "seraph-auth-fail",
      steps: [
        {
          kind: "request",
          id: "jira_search",
          method: "GET",
          url: `${mock.baseUrl}/seraph/search`,
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
    // Without the health classifier this step would "succeed" with an empty
    // body. It must fail because the upstream served an unauthenticated 200.
    expect(result.status).toBe("failed");
    expect(result.steps[0]?.status).toBe("failed");
  });

  test("a failed run emits an execution.failed event carrying the failure reason", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "fail-event",
      steps: [
        {
          kind: "request",
          id: "broken",
          method: "GET",
          url: `${mock.baseUrl}/fail/x`,
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
    expect(result.status).toBe("failed");

    const rows = await ctx.testDb.db
      .select()
      .from(events)
      .where(and(eq(events.tenant_id, ctx.tenantId), eq(events.type, "execution.failed")));
    const row = rows.find(
      (r) => (r.payload as { execution_id?: string }).execution_id === result.execution_id,
    );
    expect(row).toBeDefined();
    const payload = row?.payload as {
      workflow_id?: string;
      request_source?: string;
      failure?: { step_id?: string; error_code?: string; error_message?: string };
    };
    expect(payload.workflow_id).toBe(workflow_id);
    expect(typeof payload.request_source).toBe("string");
    expect(payload.failure?.step_id).toBe("broken");
    expect(payload.failure?.error_code).toBe("http_4xx");
    expect(typeof payload.failure?.error_message).toBe("string");
  });

  test("onError=continue lets the next step run", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "continue-mode",
      steps: [
        {
          kind: "request",
          id: "broken",
          method: "GET",
          url: `${mock.baseUrl}/fail/x`,
          on_error: "continue",
          max_retries: 0,
        },
        { kind: "request", id: "after", method: "GET", url: `${mock.baseUrl}/ok` },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: null,
    });
    expect(result.steps[0]?.status).toBe("failed");
    expect(result.steps[1]?.status).toBe("succeeded");
    // Result honesty: the tolerated failure must NOT ride RunResult.error
    // (the run is a success) — it surfaces as a warning instead.
    expect(result.error).toBeNull();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "step_failed_continued", step_key: "broken" }),
      ]),
    );
  });

  test("a continued failure followed by a genuine on_error=fail failure reports the failing step's error", async () => {
    // The tolerated failure must not leak onto RunResult.error — the
    // genuine downstream failure owns it. The two steps fail with
    // distinct codes (http_4xx vs http_5xx) so the assertion proves
    // WHICH error the envelope carries.
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "continue-then-fail",
      steps: [
        {
          kind: "request",
          id: "tolerated",
          method: "GET",
          url: `${mock.baseUrl}/fail/x`,
          on_error: "continue",
          max_retries: 0,
        },
        {
          kind: "request",
          id: "hard_fail",
          method: "GET",
          url: `${mock.baseUrl}/boom/x`,
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
    expect(result.status).toBe("failed");
    expect(result.error?.code).toBe("http_5xx");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "step_failed_continued", step_key: "tolerated" }),
      ]),
    );
  });

  test("a write that fails inside a for_each body surfaces in execution final_status", async () => {
    // Pre-fix the for_each container always finalized "succeeded" — a write
    // that 400'd/404'd inside the loop body was masked as a successful
    // execution (silent data-loss class). The failing iteration must now
    // drive final_status to "failed" under the default on_error.
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "for-each-write-fail",
      steps: [
        {
          kind: "request",
          id: "post_each",
          method: "POST",
          url: `${mock.baseUrl}/fail/x`,
          for_each: "(scope) => [1, 2]",
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
    expect(result.status).toBe("failed");
    const container = result.steps.find((s) => s.step_key === "post_each");
    expect(container?.status).toBe("failed");
  });

  test("for_each body failure with on_error=continue does NOT fail the execution", async () => {
    // The opt-out path: a body that sets on_error:"continue" tolerates its
    // own failure exactly as a non-loop step does — final_status stays
    // succeeded even though the iteration failed.
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "for-each-write-continue",
      steps: [
        {
          kind: "request",
          id: "post_each",
          method: "POST",
          url: `${mock.baseUrl}/fail/x`,
          for_each: "(scope) => [1, 2]",
          on_error: "continue",
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
    expect(result.error).toBeNull();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "step_failed_continued", step_key: "post_each" }),
      ]),
    );
  });

  test("a write that fails inside a legacy loop body surfaces in execution final_status", async () => {
    // The loop driver only resolves the collection (status "succeeded");
    // pre-fix a failed body write was stored only in the per-iteration
    // envelope and never propagated. The body step's default on_error must
    // drive final_status to "failed".
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-write-fail",
      steps: [
        {
          kind: "loop",
          id: "each",
          over: "$input",
          body: ["write_it"],
        },
        {
          kind: "request",
          id: "write_it",
          method: "POST",
          url: `${mock.baseUrl}/fail/x`,
          max_retries: 0,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: [1, 2],
    });
    expect(result.status).toBe("failed");
    const container = result.steps.find((s) => s.step_key === "each");
    expect(container?.status).toBe("failed");
  });

  test("legacy loop body failure with on_error=continue does NOT fail the execution", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-write-continue",
      steps: [
        {
          kind: "loop",
          id: "each",
          over: "$input",
          body: ["write_it"],
        },
        {
          kind: "request",
          id: "write_it",
          method: "POST",
          url: `${mock.baseUrl}/fail/x`,
          on_error: "continue",
          max_retries: 0,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: [1, 2],
    });
    expect(result.status).toBe("succeeded");
    expect(result.error).toBeNull();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "step_failed_continued", step_key: "write_it" }),
      ]),
    );
  });

  test("loop fail_fast stops the current body and later iterations after the first failure", async () => {
    const { workflow_id } = await createWorkflowRow(ctx, {
      name: "loop-fail-fast",
      steps: [
        {
          kind: "loop",
          id: "each",
          over: "$input",
          body: ["write_it", "must_not_run"],
          fail_fast: true,
        },
        {
          kind: "request",
          id: "write_it",
          method: "POST",
          url: `${mock.baseUrl}/fail/x`,
          max_retries: 0,
        },
        {
          kind: "request",
          id: "must_not_run",
          method: "GET",
          url: `${mock.baseUrl}/ok`,
        },
      ],
    });
    const result = await runExecution({
      db: ctx.testDb.db,
      tenant_id: ctx.tenantId,
      source: { kind: "saved", workflow_id },
      input: [1, 2, 3],
    });
    expect(result.status).toBe("failed");
    const iterations = result.output as Array<Record<string, unknown>>;
    expect(iterations).toHaveLength(1);
    expect(Object.keys(iterations[0] ?? {})).toEqual(["write_it"]);
  });
});
