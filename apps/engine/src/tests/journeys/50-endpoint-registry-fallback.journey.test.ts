// User story: As an operator, after a one-time document analysis pass populates
// `connector_endpoint_schemas`, every workflow step that targets a registered
// endpoint should inherit the extracted expected_statuses without needing to
// repeat them on the step.
//
// Acceptance criteria:
//   - AC1: A request step with NO `expected_statuses` succeeds when the upstream
//          returns a status the registry says is allowed.
//   - AC2: The same step FAILS with `unexpected_status_code` when the upstream
//          returns a status the registry does NOT list.
// Spec refs: plan §2h Endpoint Schema Registry — Runtime fallback.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { connectorEndpointSchemas } from "../../db/schema/index.ts";
import { createJourneyCtx, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let mockApi: Server;
let mockBase = "";
let connectorId = "";
let upstreamStatus = 201;

beforeAll(async () => {
  ctx = await createJourneyCtx("endpoint-registry-fallback");
  mockApi = createServer((_req, res) => {
    res.statusCode = upstreamStatus;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => mockApi.listen(0, "127.0.0.1", () => resolve()));
  const addr = mockApi.address() as AddressInfo;
  mockBase = `http://127.0.0.1:${addr.port}`;

  const createRes = await journeyFetch(ctx, "/v1/connectors", {
    method: "POST",
    body: JSON.stringify({
      name: "registry-fallback",
      slug: "registry-fallback",
      driver: "http",
      environment: "dev",
      auth_type: "none",
      base_url: mockBase,
    }),
  });
  if (createRes.status !== 201) throw new Error("seed connector failed");
  const created = (await createRes.json()) as { id: string };
  connectorId = created.id;

  // Simulate a prior runDocumentAnalysisFlow result: only 201 and 422 are
  // allowed for POST /v1/charges.
  await ctx.db.insert(connectorEndpointSchemas).values({
    tenant_id: ctx.tenantId,
    connector_id: connectorId,
    path: "/v1/charges",
    method: "POST",
    expected_statuses: [201, 422],
    idempotent: false,
    source: "openapi",
    confidence: 95,
  });
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => mockApi.close(() => resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
});

describe("50: registry expected_statuses fallback", () => {
  test("AC1: upstream 201 succeeds when step omits expected_statuses (registry has [201,422])", async () => {
    upstreamStatus = 201;
    const wfRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "charge-create",
        slug: "charge-create",
        steps: [
          {
            kind: "request",
            id: "create",
            method: "POST",
            connector_id: connectorId,
            path: "/v1/charges",
            body: { amount: 1000 },
          },
        ],
      }),
    });
    expect(wfRes.status).toBe(201);
    const wf = (await wfRes.json()) as { id: string };

    const runRes = await journeyFetch(ctx, `/v1/workflows/${wf.id}/run?sync=1`, {
      method: "POST",
      body: JSON.stringify({ input: {} }),
    });
    expect(runRes.status).toBe(200);
    const body = (await runRes.json()) as { status: string };
    expect(body.status).toBe("succeeded");
  });

  test("AC2: upstream 200 fails with unexpected_status_code (registry allows only [201,422])", async () => {
    // 200 is a success-range status that bypasses driver-level retry
    // logic and lands in the post-fetch validation branch — exactly
    // where the registry-driven expected_statuses check fires.
    upstreamStatus = 200;
    const wfRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "charge-create-bad",
        slug: "charge-create-bad",
        steps: [
          {
            kind: "request",
            id: "create",
            method: "POST",
            connector_id: connectorId,
            path: "/v1/charges",
            body: { amount: 1000 },
          },
        ],
      }),
    });
    expect(wfRes.status).toBe(201);
    const wf = (await wfRes.json()) as { id: string };

    const runRes = await journeyFetch(ctx, `/v1/workflows/${wf.id}/run?sync=1`, {
      method: "POST",
      body: JSON.stringify({ input: {} }),
    });
    expect(runRes.status).toBe(200);
    const body = (await runRes.json()) as {
      status: string;
      steps: Array<{ error?: { code?: string }; status: string }>;
    };
    expect(body.status).toBe("failed");
    const failed = body.steps.find((s) => s.status === "failed");
    expect(failed?.error?.code).toBe("unexpected_status_code");
  });
});
