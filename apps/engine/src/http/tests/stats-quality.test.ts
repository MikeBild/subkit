// Integration tests: GET /v1/stats/quality
//
// Covers:
//   1. Happy path: seeded executions with mixed statuses + failed steps with
//      error codes + applied patch_candidates → one_shot rate, post_repair
//      rate, failure_reasons ordering are all correct.
//   2. NULL-SAFE success rates: zero executions in window → rates are 0,
//      not NaN or divide-by-zero. THIS IS THE PERMANENT REGRESSION GATE —
//      a zero-denominator must always yield 0 not NaN.
//   3. stats:read gating: unauthenticated → 401, member role → 403.

import { createHash, randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  apiKeys,
  executions,
  executionSteps,
  patchCandidates,
  users,
  workflows,
  workflowVersions,
} from "../../db/schema/index.ts";
import { getTestNow } from "../../test-helpers/determinism/clock.ts";
import { createHttpTestServer, type HttpTestServer } from "./setup.ts";

let srv: HttpTestServer;
let memberKey = "";

function sha256Hex(v: string): string {
  return createHash("sha256").update(v).digest("hex");
}

function genKey(): { plaintext: string; prefix: string; hash: string } {
  const rand = randomBytes(24).toString("base64url").slice(0, 32); // allow-random: test isolation key
  const plaintext = `wf_live_${rand}`;
  return { plaintext, prefix: plaintext.slice(0, 12), hash: sha256Hex(plaintext) };
}

// Window relative to the actual test run so seeds always fall inside.
const NOW_MS = getTestNow();
const FROM = new Date(NOW_MS - 2 * 3_600_000).toISOString();
const TO = new Date(NOW_MS + 3_600_000).toISOString();
const WIN = `bucket=hour&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
const SEED_TS = new Date(NOW_MS - 1_800_000); // 30 min ago — always inside the window

let workflowId = "";

beforeAll(async () => {
  srv = await createHttpTestServer("stats-quality");
  const db = srv.db;

  // Member key for the 403 gate test.
  const [member] = await db
    .insert(users)
    .values({ tenant_id: srv.tenantId, email: "member-sq@test.local", role: "member" })
    .returning();
  if (!member) throw new Error("seed member failed");
  const mk = genKey();
  await db.insert(apiKeys).values({
    tenant_id: srv.tenantId,
    user_id: member.id,
    prefix: mk.prefix,
    token_sha256: mk.hash,
    scopes: ["*"],
  });
  memberKey = mk.plaintext;

  // Workflow for FK satisfaction.
  const [wf] = await db
    .insert(workflows)
    .values({
      tenant_id: srv.tenantId,
      slug: "wf-quality-test",
      name: "Quality Test WF",
      lifecycle: "active",
    })
    .returning();
  if (!wf) throw new Error("seed workflow failed");
  workflowId = wf.id;

  const [wfv] = await db
    .insert(workflowVersions)
    .values({
      tenant_id: srv.tenantId,
      workflow_id: workflowId,
      version: 1,
      dag: { steps: [] },
    })
    .returning();
  if (!wfv) throw new Error("seed workflow version failed");

  const base = { tenant_id: srv.tenantId, workflow_id: workflowId, workflow_version_id: wfv.id };

  // Seed 3 succeeded + 2 failed executions inside the window.
  const execRows = await db
    .insert(executions)
    .values([
      {
        ...base,
        status: "succeeded",
        request_source: "api",
        execution_mode: "prod",
        started_at: new Date(SEED_TS.getTime()),
        finished_at: new Date(SEED_TS.getTime() + 1_000),
      },
      {
        ...base,
        status: "succeeded",
        request_source: "api",
        execution_mode: "prod",
        started_at: new Date(SEED_TS.getTime() + 10_000),
        finished_at: new Date(SEED_TS.getTime() + 12_000),
      },
      {
        ...base,
        status: "succeeded",
        request_source: "api",
        execution_mode: "prod",
        started_at: new Date(SEED_TS.getTime() + 20_000),
        finished_at: new Date(SEED_TS.getTime() + 25_000),
      },
      {
        ...base,
        status: "failed",
        request_source: "api",
        execution_mode: "prod",
        started_at: new Date(SEED_TS.getTime() + 30_000),
        finished_at: new Date(SEED_TS.getTime() + 31_000),
      },
      {
        ...base,
        status: "failed",
        request_source: "api",
        execution_mode: "prod",
        started_at: new Date(SEED_TS.getTime() + 40_000),
        finished_at: new Date(SEED_TS.getTime() + 42_000),
      },
    ])
    .returning();

  const [, , , failedExec1, failedExec2] = execRows;
  if (!failedExec1 || !failedExec2) throw new Error("seed failed executions missing");

  // Seed execution_steps for the two failed executions with distinct error codes.
  // failure_reasons sorts by count desc → connector_timeout (2) before validation_failed (1).
  await db.insert(executionSteps).values([
    {
      tenant_id: srv.tenantId,
      execution_id: failedExec1.id,
      step_key: "step-1",
      kind: "rest",
      status: "failed",
      error: { code: "connector_timeout", message: "timeout" },
    },
    {
      tenant_id: srv.tenantId,
      execution_id: failedExec2.id,
      step_key: "step-1",
      kind: "rest",
      status: "failed",
      error: { code: "connector_timeout", message: "again" },
    },
    {
      tenant_id: srv.tenantId,
      execution_id: failedExec2.id,
      step_key: "step-2",
      kind: "transform",
      status: "failed",
      error: { code: "validation_failed", message: "schema" },
    },
  ]);

  // Seed applied patch_candidates with outcome window closed.
  await db.insert(patchCandidates).values([
    {
      tenant_id: srv.tenantId,
      workflow_id: workflowId,
      diff: { kind: "patch" },
      classification: "safe",
      status: "applied",
      outcome_window_ended_at: new Date(SEED_TS.getTime() + 60_000),
      outcome_successes_after: 3,
      outcome_failures_after: 1,
    },
    {
      tenant_id: srv.tenantId,
      workflow_id: workflowId,
      diff: { kind: "patch" },
      classification: "safe",
      status: "applied",
      outcome_window_ended_at: new Date(SEED_TS.getTime() + 120_000),
      outcome_successes_after: 2,
      outcome_failures_after: 0,
    },
  ]);
});

afterAll(async () => {
  await srv.cleanup();
});

function adminFetch(path: string): Promise<Response> {
  return fetch(`${srv.baseUrl}${path}`, {
    headers: { authorization: `Bearer ${srv.apiKey}` },
  });
}

describe("GET /v1/stats/quality — happy path", () => {
  test("one_shot counts match seeded executions", async () => {
    const res = await adminFetch(`/v1/stats/quality?${WIN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      one_shot: { succeeded: number; failed: number; total: number; success_rate: number };
    };
    expect(body.one_shot.succeeded).toBe(3);
    expect(body.one_shot.failed).toBe(2);
    expect(body.one_shot.total).toBe(5);
  });

  test("one_shot success_rate = 3/(3+2) = 0.6", async () => {
    const res = await adminFetch(`/v1/stats/quality?${WIN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { one_shot: { success_rate: number } };
    // rate(3, 5) = round(3/5 * 1000) / 1000 = 0.6
    expect(body.one_shot.success_rate).toBeCloseTo(0.6, 3);
  });

  test("failure_reasons lists connector_timeout before validation_failed (count desc)", async () => {
    const res = await adminFetch(`/v1/stats/quality?${WIN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      failure_reasons: Array<{ code: string; count: number }>;
    };
    expect(body.failure_reasons.length).toBeGreaterThanOrEqual(2);
    // connector_timeout appears in 2 steps; validation_failed in 1.
    const timeoutReason = body.failure_reasons.find((r) => r.code === "connector_timeout");
    const validationReason = body.failure_reasons.find((r) => r.code === "validation_failed");
    expect(timeoutReason?.count).toBe(2);
    expect(validationReason?.count).toBe(1);
    // Ordering: higher count first.
    const timeoutIdx = body.failure_reasons.findIndex((r) => r.code === "connector_timeout");
    const validationIdx = body.failure_reasons.findIndex((r) => r.code === "validation_failed");
    expect(timeoutIdx).toBeLessThan(validationIdx);
  });

  test("post_repair rolls up applied patch_candidates outcome windows", async () => {
    const res = await adminFetch(`/v1/stats/quality?${WIN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      post_repair: { successes: number; failures: number; success_rate: number };
    };
    // Two patches: (3 success, 1 failure) + (2 success, 0 failure) = 5 success, 1 failure
    expect(body.post_repair.successes).toBe(5);
    expect(body.post_repair.failures).toBe(1);
    // rate(5, 6) = round(5/6 * 1000) / 1000 = 0.833
    expect(body.post_repair.success_rate).toBeCloseTo(0.833, 2);
  });

  test("response envelope includes bucket, from, to fields", async () => {
    const res = await adminFetch(`/v1/stats/quality?${WIN}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { bucket: string; from: string; to: string };
    expect(body.bucket).toBe("hour");
    expect(typeof body.from).toBe("string");
    expect(typeof body.to).toBe("string");
  });
});

describe("GET /v1/stats/quality — NULL-SAFE zero-denominator gate (permanent regression)", () => {
  // THIS IS THE PERMANENT SUCCESS-RATE REGRESSION GATE.
  // A time window with no executions must return success_rate = 0,
  // not NaN and not a division-by-zero error. If this test fails it
  // means the rate() function regressed to (n/0) behaviour.
  test("zero executions in window → success_rates are 0, not NaN", async () => {
    // Use a window far in the past so it contains no seeded rows.
    const distantFrom = new Date(0).toISOString(); // 1970-01-01
    const distantTo = new Date(1_000).toISOString(); // 1970-01-01T00:00:01Z
    const emptyWin = `bucket=hour&from=${encodeURIComponent(distantFrom)}&to=${encodeURIComponent(distantTo)}`;

    const res = await adminFetch(`/v1/stats/quality?${emptyWin}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      one_shot: { succeeded: number; failed: number; total: number; success_rate: number };
      post_repair: { successes: number; failures: number; success_rate: number };
      failure_reasons: unknown[];
    };
    // one_shot
    expect(body.one_shot.succeeded).toBe(0);
    expect(body.one_shot.failed).toBe(0);
    expect(body.one_shot.total).toBe(0);
    expect(Number.isNaN(body.one_shot.success_rate)).toBe(false);
    expect(body.one_shot.success_rate).toBe(0);
    // post_repair
    expect(body.post_repair.successes).toBe(0);
    expect(body.post_repair.failures).toBe(0);
    expect(Number.isNaN(body.post_repair.success_rate)).toBe(false);
    expect(body.post_repair.success_rate).toBe(0);
    // failure_reasons
    expect(body.failure_reasons).toHaveLength(0);
  });
});

describe("GET /v1/stats/quality — RBAC gate", () => {
  test("unauthenticated → 401", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/stats/quality?${WIN}`);
    expect(res.status).toBe(401);
  });

  test("member role (no stats:read) → 403", async () => {
    const res = await fetch(`${srv.baseUrl}/v1/stats/quality?${WIN}`, {
      headers: { authorization: `Bearer ${memberKey}` },
    });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe("forbidden");
  });

  test("admin → 200", async () => {
    const res = await adminFetch(`/v1/stats/quality?${WIN}`);
    expect(res.status).toBe(200);
  });
});
