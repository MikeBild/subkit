// User story: As a platform operator, I want to onboard a new REST API
// end-to-end — connector, docs, skills, workflow, sync + async run — so
// that I can ship an automation without leaving the engine.
// Acceptance criteria:
//   - AC1: An operator can create an HTTP connector, ingest a canned
//          OpenAPI document, search over it, and attach a global skill.
//   - AC2: A workflow that references the connector runs synchronously
//          via `?sync=1` and returns the upstream body.
//   - AC3: The same workflow runs asynchronously through pg-boss, lands
//          a terminal execution row, and writes an audit entry for the
//          workflow run.
// Spec refs: docs/09-connectors.md, docs/10-docs-ingestion.md,
//            docs/18-skills.md, docs/05-execution.md

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import { auditLog, executions } from "../../db/schema/index.ts";
import { createJourneyCtx, type JourneyCtx, journeyFetch } from "./setup.ts";

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
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => mockApi.close(() => resolve()));
  if (ctx?.cleanup) await ctx.cleanup();
});

describe("journey: operator onboards a REST API", () => {
  test("AC1: create connector, ingest OpenAPI docs, search, attach a skill", async () => {
    // 1. Create the connector via REST.
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

    // 2. Ingest the OpenAPI doc.
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

    // 3. Search the ingested docs.
    const searchRes = await journeyFetch(
      ctx,
      `/v1/connectors/${connectorId}/docs/search?q=widgets`,
    );
    expect(searchRes.status).toBe(200);
    const searchBody = (await searchRes.json()) as { items: Array<{ snippet: string }> };
    expect(searchBody.items.length).toBeGreaterThanOrEqual(1);

    // 4. Attach a global skill.
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

    // Sync run.
    const runRes = await journeyFetch(ctx, `/v1/workflows/${workflowId}/run?sync=1`, {
      method: "POST",
      body: JSON.stringify({ input: {} }),
    });
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as {
      status: string;
      output: unknown;
      id: string;
    };
    expect(runBody.status).toBe("succeeded");
    expect(runBody.output).toBeDefined();
  });

  test("AC3: async run queues via pg-boss and lands terminal + audit", async () => {
    const asyncRes = await journeyFetch(ctx, `/v1/workflows/${workflowId}/run`, {
      method: "POST",
      body: JSON.stringify({ input: {}, request_source: "api" }),
    });
    expect(asyncRes.status).toBe(202);
    const asyncBody = (await asyncRes.json()) as { id: string; status: string };
    expect(asyncBody.status).toBe("queued");
    const execution_id = asyncBody.id;

    // Wait for the worker to finish.
    const deadline = Date.now() + 15_000;
    let finalStatus = "";
    while (Date.now() < deadline) {
      const rows = await ctx.db.select().from(executions).where(eq(executions.id, execution_id));
      finalStatus = rows[0]?.status ?? "";
      if (["succeeded", "failed", "aborted", "timed_out"].includes(finalStatus)) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(finalStatus).toBe("succeeded");

    // At least one audit row for workflow.created or workflow.run lives in the DB.
    const audits = await ctx.db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.tenant_id, ctx.tenantId), eq(auditLog.resource_type, "workflow")));
    expect(audits.length).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
