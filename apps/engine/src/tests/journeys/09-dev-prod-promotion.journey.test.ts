// User story: As a platform operator, I want to maintain separate dev
// and prod environments for a connector and run the same workflow
// against either, so that I can promote changes safely.
// Acceptance criteria:
//   - AC1: Creating a connector with environment=dev exposes a dev
//          credential slot.
//   - AC2: Creating a matching prod connector (same slug, different
//          environment) lives in its own row.
//   - AC3: Running the workflow against dev records execution_mode=dev.
// Spec refs: docs/05-connectors.md, docs/06-execution.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { connectors, executions } from "../../db/schema/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let mockDev: Server;
let mockDevBase = "";
let mockProd: Server;
let mockProdBase = "";
let devHits = 0;
let prodHits = 0;
let devConnectorId = "";
let prodConnectorId = "";
let workflowId = "";

beforeAll(async () => {
  ctx = await createJourneyCtx("dev-prod");

  mockDev = createServer((_req, res) => {
    devHits += 1;
    res.setHeader("content-type", "application/json");
    res.statusCode = 200;
    res.end(JSON.stringify({ env: "dev", ok: true }));
  });
  await new Promise<void>((resolve) => mockDev.listen(0, "127.0.0.1", () => resolve()));
  const addrDev = mockDev.address() as AddressInfo;
  mockDevBase = `http://127.0.0.1:${addrDev.port}`;

  mockProd = createServer((_req, res) => {
    prodHits += 1;
    res.setHeader("content-type", "application/json");
    res.statusCode = 200;
    res.end(JSON.stringify({ env: "prod", ok: true }));
  });
  await new Promise<void>((resolve) => mockProd.listen(0, "127.0.0.1", () => resolve()));
  const addrProd = mockProd.address() as AddressInfo;
  mockProdBase = `http://127.0.0.1:${addrProd.port}`;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await new Promise<void>((resolve) => mockDev.close(() => resolve()));
  await new Promise<void>((resolve) => mockProd.close(() => resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey: dev/prod promotion", () => {
  test("AC1: create dev connector and attach a bearer credential", async () => {
    const res = await journeyFetch(ctx, "/v1/connectors", {
      method: "POST",
      body: JSON.stringify({
        name: "Payments",
        slug: "payments",
        driver: "http",
        environment: "dev",
        auth_type: "bearer",
        base_url: mockDevBase,
      }),
    });
    expect(res.status).toBe(201);
    devConnectorId = ((await res.json()) as { id: string }).id;

    const credRes = await journeyFetch(ctx, `/v1/connectors/${devConnectorId}/credentials`, {
      method: "POST",
      body: JSON.stringify({ mode: "bearer", token: "dev-secret-abc" }),
    });
    expect(credRes.status).toBe(201);
  });

  test("AC2: create prod connector with same slug in its own row", async () => {
    const res = await journeyFetch(ctx, "/v1/connectors", {
      method: "POST",
      body: JSON.stringify({
        name: "Payments Prod",
        slug: "payments",
        driver: "http",
        environment: "prod",
        auth_type: "bearer",
        base_url: mockProdBase,
      }),
    });
    expect(res.status).toBe(201);
    prodConnectorId = ((await res.json()) as { id: string }).id;

    // Prod has its own credential distinct from dev.
    const credRes = await journeyFetch(ctx, `/v1/connectors/${prodConnectorId}/credentials`, {
      method: "POST",
      body: JSON.stringify({ mode: "bearer", token: "prod-secret-xyz" }),
    });
    expect(credRes.status).toBe(201);

    const rows = await ctx.db
      .select()
      .from(connectors)
      .where(and(eq(connectors.tenant_id, ctx.tenantId), eq(connectors.slug, "payments")));
    expect(rows.length).toBe(2);
    expect(rows.map((r) => r.environment).sort()).toEqual(["dev", "prod"]);
  });

  test("AC3: running against dev tags execution_mode=dev", async () => {
    const wfRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "probe dev",
        slug: "probe-dev",
        steps: [
          {
            kind: "request",
            id: "hit",
            method: "GET",
            connector_id: devConnectorId,
            path: "/",
          },
        ],
      }),
    });
    expect(wfRes.status).toBe(201);
    workflowId = ((await wfRes.json()) as { id: string }).id;

    const run = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: workflowId, input: {} }),
    });
    expect(run.status).toBe(200);
    const rb = (await run.json()) as { execution_id: string; status: string };
    expect(rb.status).toBe("succeeded");

    const rows = await ctx.db.select().from(executions).where(eq(executions.id, rb.execution_id));
    expect(rows[0]?.execution_mode).toBe("dev");
  });

  test("AC4: `x-subkit-environment: prod` routes to the prod connector row and tags execution_mode=prod", async () => {
    // Sanity: the AC3 run above already incremented dev hits and zero
    // prod hits.
    expect(devHits).toBeGreaterThanOrEqual(1);
    expect(prodHits).toBe(0);
    const devHitsBefore = devHits;

    const run = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      headers: { "x-subkit-environment": "prod" },
      body: JSON.stringify({ source: "saved", workflow_id: workflowId, input: {} }),
    });
    expect(run.status).toBe(200);
    const rb = (await run.json()) as { execution_id: string; status: string };
    expect(rb.status).toBe("succeeded");

    // The prod mock was hit, not dev.
    expect(prodHits).toBe(1);
    expect(devHits).toBe(devHitsBefore);

    const rows = await ctx.db.select().from(executions).where(eq(executions.id, rb.execution_id));
    expect(rows[0]?.execution_mode).toBe("prod");

    // Touch prodConnectorId so the unused-variable lint stays quiet.
    expect(prodConnectorId.length).toBeGreaterThan(0);
  });
});
