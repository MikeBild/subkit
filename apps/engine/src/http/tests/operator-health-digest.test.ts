// Integration test for GET /v1/operator/health-digest.
//
// Proves: unauthenticated → 401; admin key → 200 with a grouped,
// origin-tagged digest computed from real executions.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { executionSteps, executions } from "../../db/schema/index.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;

beforeAll(async () => {
  srv = await createHttpTestServer("operator_digest");
  // One scheduled failure with a connector-authored guidance hint.
  const [exec] = await srv.db
    .insert(executions)
    .values({
      tenant_id: srv.tenantId,
      status: "failed",
      source_kind: "saved",
      request_source: "scheduler",
      execution_mode: "dev",
    })
    .returning();
  await srv.db.insert(executionSteps).values({
    tenant_id: srv.tenantId,
    execution_id: exec!.id,
    step_key: "fetch",
    step_index: 0,
    kind: "request",
    status: "failed",
    error: { code: "http_4xx", message: "http 404", guidance: "The path is wrong." },
  });
});

afterAll(async () => {
  await srv.cleanup();
});

describe("GET /v1/operator/health-digest", () => {
  test("401 unauthenticated", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/operator/health-digest`);
    expect(res.status).toBe(401);
  });

  test("200 with a grouped, origin-tagged digest", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/operator/health-digest`, {
      headers: { Authorization: `Bearer ${srv.apiKey}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      all_clear: boolean;
      failure_groups: Array<{ origin: string; error_code: string; guidance: string | null }>;
      headline: string;
    };
    expect(body.all_clear).toBe(false);
    const group = body.failure_groups.find((g) => g.error_code === "http_4xx");
    expect(group?.origin).toBe("scheduled");
    expect(group?.guidance).toBe("The path is wrong.");
    expect(body.headline).toContain("scheduled");
  });
});
