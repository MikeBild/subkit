import { afterAll, beforeAll, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { serializeStep } from "../../api/operations/execution-representation.ts";
import { executionSteps } from "../../db/schema/index.ts";
import { runExecution } from "../engine.ts";
import { deriveExecutionOutcome } from "../outcome.ts";
import { RequestMetaSchema } from "../request-meta-schema.ts";
import {
  createEngineCtx,
  createMockServer,
  createWorkflowRow,
  type EngineTestCtx,
  type MockServer,
} from "./setup.ts";

const ARGV = ["--token", "PRIVATE-ARGV-canary"];
const NAME = "PRIVATE-NAME-canary";
const UPSTREAM_CODE = "invalid_token_PRIVATE";

let ctx: EngineTestCtx;
let mock: MockServer;

beforeAll(async () => {
  ctx = await createEngineCtx("sensitive-failure-diagnostics");
  mock = await createMockServer((req, res) => {
    const status = Number(new URL(req.url ?? "/", "http://mock").pathname.slice(1));
    res.statusCode = status;
    res.setHeader("content-type", "application/json");
    res.setHeader("x-request-id", "PRIVATE-HEADER-canary");
    res.end(JSON.stringify({ error: { code: UPSTREAM_CODE, message: "PRIVATE-BODY-canary" } }));
  });
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

async function runSensitive(slug: string, url: string) {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name: slug,
    slug,
    execution_privacy: "sensitive",
    steps: [
      {
        id: "send",
        kind: "request",
        method: "POST",
        url,
        side_effects: "read",
        max_retries: 0,
        body: { app: { argv: "${input.argv}", name: "${input.name}", note: "hi ${input.name}" } },
      },
    ],
  });
  const result = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: { argv: ARGV, name: NAME },
  });
  const rows = await ctx.testDb.db
    .select()
    .from(executionSteps)
    .where(
      and(
        eq(executionSteps.tenant_id, ctx.tenantId),
        eq(executionSteps.execution_id, result.execution_id),
      ),
    );
  return { result, row: rows[0] };
}

function expectNothingPrivate(value: unknown, status: string) {
  const text = JSON.stringify(value);
  for (const hidden of ["PRIVATE", status, UPSTREAM_CODE, "x-request-id", mock.baseUrl])
    expect(text).not.toContain(hidden);
}

test("a sensitive 4xx failure stores its class, placeholder types and body size only", async () => {
  const { result, row } = await runSensitive("sensitive-diag-401", `${mock.baseUrl}/401`);
  expect(result.status).toBe("failed");
  if (!row) throw new Error("step row missing");
  const expected = {
    driver: "sensitive" as const,
    status_class: "4xx" as const,
    placeholder_types: { "input.argv": "array" as const, "input.name": "string" as const },
    body_size: "<1KB" as const,
  };
  expect(row.request_meta).toEqual(expected);
  expect(RequestMetaSchema.parse(row.request_meta)).toEqual(expected as never);
  expect(row.error).toMatchObject({ status_class: "4xx" });
  const detail = serializeStep(row);
  expectNothingPrivate(detail.request_meta, "401");
  expectNothingPrivate(detail.error, "401");
  expectNothingPrivate(result.steps[0]?.request_meta, "401");
  expect(result.steps[0]?.request_meta).toEqual(expected);
  const outcome = deriveExecutionOutcome(
    {
      status: "failed",
      failure: {
        step_id: "send",
        error_code: "sensitive_execution_failure",
        error_message: "Sensitive execution failed.",
      },
      output_contract: "none",
    },
    [{ ...row, held: false }],
  );
  expect(outcome.status_class).toBe("4xx");
});

test("a sensitive 5xx failure reads as an upstream failure, not as sign-in", async () => {
  const { row } = await runSensitive("sensitive-diag-503", `${mock.baseUrl}/503`);
  if (!row) throw new Error("step row missing");
  expect(row.request_meta).toMatchObject({ driver: "sensitive", status_class: "5xx" });
  expectNothingPrivate(row.request_meta, "503");
  expectNothingPrivate(row.error, "503");
});

test("a sensitive network failure reads as network", async () => {
  const { row } = await runSensitive("sensitive-diag-network", "http://127.0.0.1:9/closed");
  if (!row) throw new Error("step row missing");
  expect(row.request_meta).toMatchObject({ driver: "sensitive", status_class: "network" });
  expectNothingPrivate(row.request_meta, "ECONNREFUSED");
});
