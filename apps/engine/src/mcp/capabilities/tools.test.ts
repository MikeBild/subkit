// Integration tests for MCP tools/list and tools/call (T22 + T7 from manifest).
//
// T22: After the catalog refactor, tools/list still surfaces `wf_<slug>`
//      entries with the same shape MCP clients expect.
// T7:  tools/call for `wf_<slug>` drives runExecution end-to-end.
//
// Uses the journey harness (createJourneyCtx + MCP StreamableHTTP client)
// so tests reach the engine via its public MCP contracts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { count, eq } from "drizzle-orm";
import { executions, workflows } from "../../db/schema/index.ts";
import {
  createJourneyCtx,
  JOURNEY_HOOK_TIMEOUT,
  type JourneyCtx,
  journeyFetch,
} from "../../tests/journeys/setup.ts";

let ctx: JourneyCtx;
let mock: Server;
let mockBase = "";
let toolWfSlug: string;
let toolWfId: string;

async function connect(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(ctx.mcpUrl), {
    requestInit: { headers: { authorization: `Bearer ${ctx.apiKey}` } },
  });
  const client = new Client({ name: "subkit-tools-test", version: "0.0.0" });
  await client.connect(transport as unknown as Transport);
  return client;
}

beforeAll(async () => {
  ctx = await createJourneyCtx("mcp-tools-catalog");

  // Spin up a mock HTTP target so the workflow step doesn't fail with ECONNREFUSED
  mock = createServer((_req, res) => {
    res.setHeader("content-type", "application/json");
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", () => resolve()));
  const addr = mock.address() as AddressInfo;
  mockBase = `http://127.0.0.1:${addr.port}`;

  // Seed a workflow via the REST API so it's properly cataloged
  toolWfSlug = "catalog-regression-wf";
  const createRes = await journeyFetch(ctx, "/v1/workflows", {
    method: "POST",
    body: JSON.stringify({
      name: "Catalog Regression WF",
      slug: toolWfSlug,
      steps: [{ kind: "request", id: "probe", method: "GET", url: `${mockBase}/test` }],
    }),
  });
  const wfBody = (await createRes.json()) as { id: string };
  toolWfId = wfBody.id;
}, JOURNEY_HOOK_TIMEOUT);

afterAll(async () => {
  await new Promise<void>((resolve) => mock.close(() => resolve()));
  await ctx.cleanup();
}, JOURNEY_HOOK_TIMEOUT);

// ---------------------------------------------------------------------------
// T22: tools/list surfaces wf_<slug> entries after catalog refactor
// ---------------------------------------------------------------------------

describe("MCP tools/list — wf_<slug> catalog (T22)", () => {
  test("tools/list over MCP returns the seeded wf_<slug> tool", async () => {
    const client = await connect();
    try {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).toContain(`wf_${toolWfSlug}`);
    } finally {
      await client.close();
    }
  });

  test("wf_<slug> tool has name, description, and inputSchema", async () => {
    const client = await connect();
    try {
      const list = await client.listTools();
      const tool = list.tools.find((t) => t.name === `wf_${toolWfSlug}`);
      expect(tool).toBeDefined();
      expect(typeof tool!.name).toBe("string");
      expect(typeof tool!.description).toBe("string");
      expect(typeof tool!.inputSchema).toBe("object");
    } finally {
      await client.close();
    }
  });

  test("static read tools ride alongside wf_ entries; draft_write tools stay hidden", async () => {
    const client = await connect();
    try {
      const list = await client.listTools();
      const names = new Set(list.tools.map((t) => t.name));
      // Static tenant_read tools (list_recipes, test_connector) ride in the
      // live tools/list alongside the dynamic wf_<slug> entries. draft_write
      // authoring tools (propose_step, save_workflow_draft) are
      // in-conversation only and must NOT leak into the MCP catalog — see
      // tenant-tools.ts (a draft_write category returns false from the
      // exposure gate).
      expect(names.has("list_recipes")).toBe(true);
      expect(names.has("test_connector")).toBe(true);
      expect(names.has("propose_step")).toBe(false);
      expect(names.has("save_workflow_draft")).toBe(false);
    } finally {
      await client.close();
    }
  });

  test("REST GET /v1/mcp/tools returns the static structured-intent palette", async () => {
    // Note: the REST /v1/mcp/tools endpoint returns the static structured-intent
    // conversation tools (propose_step, save_workflow_draft, etc.). The wf_<slug>
    // dynamic catalog only appears via the live MCP protocol (tools/list over
    // StreamableHTTP). This test verifies the REST endpoint itself is healthy.
    const res = await journeyFetch(ctx, "/v1/mcp/tools");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ name: string }> };
    expect(Array.isArray(body.items)).toBe(true);
    // Static tools are always present
    const names = new Set(body.items.map((t) => t.name));
    expect(names.has("propose_step")).toBe(true);
  });

  test("workflow with is_tool=false is NOT surfaced in tools/list", async () => {
    // Create a non-tool workflow via REST
    const noToolSlug = "non-tool-catalog-wf";
    const createRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "Non Tool WF",
        slug: noToolSlug,
        steps: [{ kind: "request", id: "s1", url: `${mockBase}` }],
      }),
    });
    const noToolBody = (await createRes.json()) as { id: string };
    // Mark as non-tool via DB
    await ctx.db.update(workflows).set({ is_tool: false }).where(eq(workflows.id, noToolBody.id));

    const client = await connect();
    try {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).not.toContain(`wf_${noToolSlug}`);
    } finally {
      await client.close();
    }
  });
});

// ---------------------------------------------------------------------------
// T7: tools/call for wf_<slug> drives runExecution end-to-end
// ---------------------------------------------------------------------------

describe("MCP tools/call — wf_<slug> end-to-end (T7)", () => {
  test("tools/call runs the workflow and creates an execution row", async () => {
    const priorCount =
      (
        await ctx.db
          .select({ c: count() })
          .from(executions)
          .where(eq(executions.workflow_id, toolWfId))
      )[0]?.c ?? 0;

    const client = await connect();
    try {
      const result = await client.callTool({
        name: `wf_${toolWfSlug}`,
        arguments: {},
      });
      // Either succeeds or returns a policy-pending envelope — both are non-error
      expect(result.isError).toBeFalsy();
    } finally {
      await client.close();
    }

    // Verify an execution row was created
    const afterCount =
      (
        await ctx.db
          .select({ c: count() })
          .from(executions)
          .where(eq(executions.workflow_id, toolWfId))
      )[0]?.c ?? 0;
    expect(afterCount).toBeGreaterThan(priorCount);
  });

  test("tools/call for unknown wf_<slug> returns an error envelope", async () => {
    const client = await connect();
    try {
      const result = await client.callTool({
        name: "wf_definitely-not-a-real-slug-xyz123",
        arguments: {},
      });
      // MCP wraps errors in isError=true content
      expect(result.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});
