import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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
const hits: string[] = [];

beforeAll(async () => {
  ctx = await createEngineCtx("runtime-destination");
  mock = await createMockServer(async (req, res) => {
    hits.push(req.url ?? "");
    return jsonResponse(res, 200, { ok: true });
  });
});

afterAll(async () => {
  await mock.close();
  await ctx.cleanup();
});

const fetchStep = (allowed_hosts: unknown) => ({
  kind: "request",
  id: "fetch",
  method: "GET",
  url: "${input.url}",
  boundary: { variables: {}, max_body_bytes: 0, max_calls: 1, allowed_hosts },
});

const failure = async (name: string, allowed_hosts: unknown, url: string) => {
  const { workflow_id } = await createWorkflowRow(ctx, {
    name,
    steps: [fetchStep(allowed_hosts)],
  });
  const run = await runExecution({
    db: ctx.testDb.db,
    tenant_id: ctx.tenantId,
    source: { kind: "saved", workflow_id },
    input: { url },
  });
  expect(run.status).toBe("failed");
  return run.steps.find((step) => step.step_key === "fetch")?.error as {
    code?: string;
    message?: string;
  };
};

describe("a runtime url under an allowed host list (#859)", () => {
  test("a url off the list fails closed before anything is sent", async () => {
    hits.length = 0;
    const error = await failure("off-the-list", ["docs.example.com"], `${mock.baseUrl}/data`);
    expect(error.code).toBe("request_host_not_allowed");
    expect(error.message).toContain("docs.example.com");
    expect(error.message).toContain("only https is allowed");
    expect(hits).toEqual([]);
  });

  test("a host list that was never pinned fails closed with its own code", async () => {
    hits.length = 0;
    const error = await failure("never-pinned", "${input.allowed_hosts}", `${mock.baseUrl}/data`);
    expect(error.code).toBe("request_destination_unbounded");
    expect(hits).toEqual([]);
  });
});
