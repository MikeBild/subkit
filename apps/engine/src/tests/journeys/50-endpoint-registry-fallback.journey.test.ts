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

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";

import {
  browserSessionCookie,
  signBrowserCsrf,
  signBrowserSession,
} from "../../auth/browser-session.ts";
import { connectorEndpointSchemas, sessions, workflows } from "../../db/schema/index.ts";
import { databaseNow } from "../../test-helpers/database-clock.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let mockApi: Server;
let mockBase = "";
let connectorId = "";
let upstreamStatus = 201;
let requests = 0;

// This journey tests actual POST response classification, not preparation.
// Grant one finite live run explicitly; the normal API must not infer it.
async function authorizeLiveFixture(workflowId: string) {
  const [workflow] = await ctx.db
    .update(workflows)
    .set({ lifecycle: "active" })
    .where(eq(workflows.id, workflowId))
    .returning();
  if (!workflow?.current_version_id) throw new Error("missing workflow version");
  const now = await databaseNow(ctx.db);
  const [session] = await ctx.db
    .insert(sessions)
    .values({
      tenant_id: ctx.tenantId,
      user_id: ctx.userId,
      expires_at: new Date(now.getTime() + 3600000),
      absolute_expires_at: new Date(now.getTime() + 3600000),
    })
    .returning();
  if (!session) throw new Error("missing browser fixture");
  const payload = { tenant_id: ctx.tenantId, user_id: ctx.userId, session_id: session.id };
  const previewResponse = await journeyFetch(
    ctx,
    `/v1/workflows/${workflowId}/versions/${workflow.current_version_id}/authority-preview`,
  );
  expect(previewResponse.status).toBe(200);
  const preview = (await previewResponse.json()) as {
    digest: string;
    suggested_bounds: { valid_from: string; valid_until: string };
  };
  const granted = await fetch(`${ctx.baseUrl}/v1/workflows/${workflowId}/execution-authorities`, {
    method: "POST",
    headers: {
      cookie: browserSessionCookie(await signBrowserSession(payload)),
      "x-subkit-csrf": await signBrowserCsrf(payload),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      workflow_version_id: workflow.current_version_id,
      expected_manifest_digest: preview.digest,
      execution_environment: "dev",
      ...preview.suggested_bounds,
      max_runs: 1,
    }),
  });
  expect(granted.status).toBe(201);
}

beforeAll(async () => {
  ctx = await createJourneyCtx("endpoint-registry-fallback");
  mockApi = createServer((_req, res) => {
    requests++;
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
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await new Promise<void>((resolve) => mockApi.close(() => resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

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
    await authorizeLiveFixture(wf.id);

    const runRes = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: wf.id, input: {} }),
    });
    expect(runRes.status).toBe(200);
    const body = (await runRes.json()) as { status: string };
    expect(body.status).toBe("succeeded");
    expect(requests).toBe(1);
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
    await authorizeLiveFixture(wf.id);

    const runRes = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: wf.id, input: {} }),
    });
    expect(runRes.status).toBe(200);
    const body = (await runRes.json()) as {
      status: string;
      steps: Array<{ error?: { code?: string }; status: string }>;
    };
    expect(body.status).toBe("failed");
    const failed = body.steps.find((s) => s.status === "failed");
    expect(failed?.error?.code).toBe("unexpected_status_code");
    expect(requests).toBe(2);
  });
});
