import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { auditLog, executions } from "../../db/schema/index.ts";
import { waitFor } from "../../test-helpers/determinism/index.ts";
import { createJourneyCtx, JOURNEY_HOOK_TIMEOUT, type JourneyCtx, journeyFetch } from "./setup.ts";

let ctx: JourneyCtx;
let mockApi: Server;
let mockBase = "";
let connectorId = "";
let workflowId = "";

const CANNED_OPENAPI = {
  openapi: "3.0.0",
  info: { title: "Widgets", version: "1.0" },
  paths: {
    "/widgets": {
      get: {
        operationId: "listWidgets",
        summary: "List widgets",
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

beforeAll(async () => {
  ctx = await createJourneyCtx("onboard-rest");

  mockApi = createServer((req, res) => {
    const url = req.url ?? "/";
    res.setHeader("content-type", "application/json");
    if (url.startsWith("/openapi.json")) {
      res.statusCode = 200;
      res.end(JSON.stringify(CANNED_OPENAPI));
      return;
    }
    if (url.startsWith("/widgets")) {
      res.statusCode = 200;
      res.end(JSON.stringify({ items: [{ id: "w-1", name: "alpha" }] }));
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>((resolve) => mockApi.listen(0, "127.0.0.1", () => resolve()));
  const addr = mockApi.address() as AddressInfo;
  mockBase = `http://127.0.0.1:${addr.port}`;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await new Promise<void>((resolve) => mockApi.close(() => resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

describe("journey: operator onboards a REST API", () => {
  test("AC1: create connector, ingest OpenAPI docs, search, attach a skill", async () => {
    const createRes = await journeyFetch(ctx, "/v1/connectors", {
      method: "POST",
      body: JSON.stringify({
        name: "Widgets",
        slug: "widgets",
        driver: "http",
        environment: "dev",
        auth_type: "none",
        base_url: mockBase,
      }),
    });
    expect(createRes.status).toBe(201);
    const connector = (await createRes.json()) as { id: string; slug: string };
    connectorId = connector.id;
    expect(connector.slug).toBe("widgets");

    const ingestRes = await journeyFetch(ctx, `/v1/connectors/${connectorId}/docs/ingest`, {
      method: "POST",
      body: JSON.stringify({
        source_type: "openapi",
        url: `${mockBase}/openapi.json`,
      }),
    });
    expect(ingestRes.status).toBe(200);
    const ingested = (await ingestRes.json()) as { ingested_count: number };
    expect(ingested.ingested_count).toBeGreaterThanOrEqual(1);

    const searchRes = await journeyFetch(
      ctx,
      `/v1/connectors/${connectorId}/docs/search?q=widgets`,
    );
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as { items: Array<{ snippet: string }> };
    expect(searchBody.items.length).toBeGreaterThanOrEqual(1);

    const skillRes = await journeyFetch(ctx, "/v1/skills", {
      method: "POST",
      body: JSON.stringify({
        scope: "global",
        title: "prefer GET for lists",
        body: "Use GET /widgets when listing — the endpoint is idempotent.",
        status: "active",
      }),
    });
    expect(skillRes.status).toBe(201);
  });

  test("AC2: create workflow referencing the connector and run it synchronously", async () => {
    const createWfRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "list-widgets",
        slug: "list-widgets",
        steps: [
          {
            kind: "request",
            id: "widgets",
            method: "GET",
            connector_id: connectorId,
            path: "/widgets",
          },
        ],
      }),
    });
    expect(createWfRes.status).toBe(201);
    const wf = (await createWfRes.json()) as { id: string };
    workflowId = wf.id;

    const runRes = await journeyFetch(ctx, "/v1/executions", {
      method: "POST",
      body: JSON.stringify({ source: "saved", workflow_id: workflowId, input: {} }),
    });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as {
      status: string;
      output: unknown;
      execution_id: string;
    };
    expect(runBody.status).toBe("succeeded");
    expect(runBody.output).toBeDefined();
  });

  test(
    "AC3: async run queues via pg-boss and lands terminal + audit",
    async () => {
      const asyncRes = await journeyFetch(ctx, "/v1/executions", {
        method: "POST",
        body: JSON.stringify({
          source: "saved",
          workflow_id: workflowId,
          input: {},
          request_source: "api",
          async: true,
        }),
      });
      expect(asyncRes.status).toBe(202);
      const asyncBody = (await asyncRes.json()) as { execution_id: string; status: string };
      expect(asyncBody.status).toBe("queued");
      const execution_id = asyncBody.execution_id;

      const finalStatus = await waitFor(
        async () => {
          const rows = await ctx.db
            .select()
            .from(executions)
            .where(eq(executions.id, execution_id));
          const s = rows[0]?.status ?? "";
          return ["succeeded", "failed", "aborted", "timed_out"].includes(s) ? s : undefined;
        },
        { tries: 150, sleepMs: 100, label: "run terminal" },
      );
      expect(finalStatus).toBe("succeeded");

      const audits = await ctx.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_type, "workflow")));
      expect(audits.length).toBeGreaterThanOrEqual(1);
    },
    JOURNEY_HOOK_TIMEOUT,
  );
});
