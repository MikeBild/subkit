import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
  seedWorkflow,
} from "./setup.ts";

let ctx: JourneyCtx;
let upstream: Server;
let base = "";
let connectorId = "";
let workflowId = "";
let failedId = "";
let rerunId = "";

interface Detail {
  status: string;
  parent_execution_id: string | null;
  source_ref: Record<string, unknown> | null;
  input: unknown;
  outcome: { cause_class: string | null; error_code: string | null };
}

beforeAll(async () => {
  ctx = await createJourneyCtx("core-failed-run-remedy");
  upstream = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url?.startsWith("/current")) {
      res.statusCode = 200;
      res.end(JSON.stringify({ orders: [{ id: "A-1", total: 42 }] }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "this address was retired" }));
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", () => resolve()));
  base = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const created = await journeyFetch(ctx, "/v1/connectors", {
    method: "POST",
    body: JSON.stringify({
      name: "Shop",
      slug: "shop",
      driver: "http",
      environment: "prod",
      auth_type: "none",
      base_url: `${base}/retired`,
    }),
  });
  expect(created.status).toBe(201);
  connectorId = ((await created.json()) as { id: string }).id;

  const workflow = await seedWorkflow(ctx, {
    slug: "daily-orders",
    name: "Daily orders",
    steps: [
      { id: "orders", kind: "request", connector_id: connectorId, method: "GET", path: "/orders" },
    ],
  });
  workflowId = workflow.id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await new Promise<void>((resolve) => (upstream ? upstream.close(() => resolve()) : resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

async function detail(id: string): Promise<Detail> {
  const res = await journeyFetch(ctx, `/v1/executions/${id}`);
  expect(res.status).toBe(200);
  return (await res.json()) as Detail;
}

describe("a failed run shows its remedy, the person fixes the cause and the rerun succeeds", () => {
  test("the run fails at the request step and names a cause the run page turns into a remedy", async () => {
    const res = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: workflowId, input: { day: "monday" } }),
    });
    const body = (await res.json()) as { execution_id: string; status: string };
    expect(body.status).toBe("failed");
    failedId = body.execution_id;
    const run = await detail(failedId);
    expect(run.status).toBe("failed");
    expect(run.outcome.cause_class).toBe("driver_error");
    const listed = await journeyFetch(ctx, `/v1/executions?workflow_id=${workflowId}&limit=10`);
    const rows = (await listed.json()) as {
      items: Array<{
        id: string;
        failure: { step_id?: string; cause_class: string | null } | null;
      }>;
    };
    const row = rows.items.find((item) => item.id === failedId);
    expect(row?.failure?.cause_class).toBe(run.outcome.cause_class);
  });

  test("a rerun before the fix fails the same way", async () => {
    const res = await journeyFetch(ctx, `/v1/executions/${failedId}/rerun`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("failed");
  });

  test("the person points the connector at the current address and its test passes", async () => {
    const patched = await journeyFetch(ctx, `/v1/connectors/${connectorId}`, {
      method: "PATCH",
      body: JSON.stringify({ base_url: `${base}/current` }),
    });
    expect(patched.status).toBe(200);
    const probe = await journeyFetch(ctx, `/v1/connectors/${connectorId}/test`, {
      method: "POST",
    });
    expect(((await probe.json()) as { ok: boolean }).ok).toBe(true);
  });

  test("the rerun of the failed run succeeds with the original input and its lineage", async () => {
    const res = await journeyFetch(ctx, `/v1/executions/${failedId}/rerun`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { execution_id: string; status: string };
    expect(body.status).toBe("succeeded");
    rerunId = body.execution_id;
    const run = await detail(rerunId);
    expect(run.parent_execution_id).toBe(failedId);
    expect(run.source_ref).toMatchObject({ rerun_of: failedId });
    expect(run.input).toMatchObject({ day: "monday" });
    expect(run.outcome.cause_class === null || run.outcome.cause_class === "ok").toBe(true);
  });

  test("the audit shows the failed run, the connector fix and the successful rerun", async () => {
    const res = await journeyFetch(ctx, "/v1/audit-log?limit=200");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: Array<{
        action: string;
        result: string;
        resource_id: string | null;
        metadata: Record<string, unknown> | null;
      }>;
    };
    const about = (id: string) => body.items.filter((row) => row.resource_id === id);
    expect(about(failedId).some((row) => row.action === "execution.started")).toBe(true);
    expect(about(connectorId).some((row) => row.action === "connector.updated")).toBe(true);
    const rerunRows = about(rerunId);
    expect(
      rerunRows.some((row) => row.action === "execution.completed" && row.result === "success"),
    ).toBe(true);
  });
});
