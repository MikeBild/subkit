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

  test("conversation tools are present alongside wf_ entries; draft_write is hidden on MCP", async () => {
    const client = await connect();
    try {
      const list = await client.listTools();
      const names = new Set(list.tools.map((t) => t.name));
      // Static/product tools coexist with wf_<slug> entries: list_recipes +
      // test_connector remain visible alongside the dynamic catalog.
      expect(names.has("list_recipes")).toBe(true);
      expect(names.has("test_connector")).toBe(true);
      // draft_write authoring tools are conversation-scoped and HIDDEN from
      // the MCP catalog in every mode (a direct tools/call short-circuits to
      // not_available_on_surface — see tools-list-disabled.test.ts). They
      // used to surface here as disabled-badged descriptors.
      expect(names.has("edit_workflow_patch")).toBe(false);
      expect(names.has("save_workflow_draft")).toBe(false);
    } finally {
      await client.close();
    }
  });

  test("every tool advertises MCP annotations; reads/writes/runs are classified", async () => {
    // Regression guard: a strict MCP client (ChatGPT/codex) reads
    // Tool.annotations to decide whether it may invoke a tool without its own
    // gate. Missing/incorrect hints re-block the authoring tools.
    const client = await connect();
    try {
      const list = await client.listTools();
      const byName = new Map(list.tools.map((t) => [t.name, t]));

      // Every tool carries annotations.
      for (const t of list.tools) expect(t.annotations).toBeDefined();

      // A read tool is read-only.
      expect(byName.get("list_recipes")?.annotations?.readOnlyHint).toBe(true);

      // The workflow-run tool is not read-only and is open-world.
      const wf = byName.get(`wf_${toolWfSlug}`);
      expect(wf?.annotations?.readOnlyHint).toBe(false);
      expect(wf?.annotations?.openWorldHint).toBe(true);
      // (conversation_start's non-destructive-write annotation — the hint that
      // unblocks strict clients — is unit-tested in tool-meta.test.ts; it is
      // not surfaced to this api-key principal's product-mode catalog.)
    } finally {
      await client.close();
    }
  });

  test("REST GET /v1/mcp/tools returns the static structured-intent palette", async () => {
    // Note: the REST /v1/mcp/tools endpoint returns the static structured-intent
    // conversation tools (author_workflow, save_workflow_draft, etc.). The wf_<slug>
    // dynamic catalog only appears via the live MCP protocol (tools/list over
    // StreamableHTTP). This test verifies the REST endpoint itself is healthy.
    const res = await journeyFetch(ctx, "/v1/mcp/tools");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: Array<{ name: string }> };
    expect(Array.isArray(body.items)).toBe(true);
    // Static tools are always present
    const names = new Set(body.items.map((t) => t.name));
    expect(names.has("author_workflow")).toBe(true);
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
      // W4.5 anti-spiral: the dead-end is a TERMINAL, actionable envelope,
      // not a bare "workflow not found" string a client can loop on.
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (b) => b.type === "text",
      )?.text;
      const body = JSON.parse(text!) as {
        status: string;
        error_code: string;
        next_best_actions: string[];
      };
      expect(body.status).toBe("cannot_help");
      expect(body.error_code).toBe("workflow_not_found");
      expect(body.next_best_actions).toContain("find_workflow");
    } finally {
      await client.close();
    }
  });

  test("tools/call for a tool absent from this surface returns a terminal cannot_help", async () => {
    // A strict client that reaches for a tool name that is neither a
    // wf_<slug>, a conversation_ RPC, nor a registry tool used to get a
    // bare "unknown tool: X" string — an ambiguous dead-end. It must now
    // be a terminal, actionable cannot_help naming the recovery path.
    const client = await connect();
    try {
      const result = await client.callTool({
        name: "totally_made_up_tool_xyz",
        arguments: {},
      });
      expect(result.isError).toBe(true);
      const text = (result.content as Array<{ type: string; text?: string }>).find(
        (b) => b.type === "text",
      )?.text;
      const body = JSON.parse(text!) as {
        status: string;
        error_code: string;
        next_best_actions: string[];
      };
      expect(body.status).toBe("cannot_help");
      expect(body.error_code).toBe("unknown_tool");
      expect(body.next_best_actions).toContain("conversation_start");
    } finally {
      await client.close();
    }
  });
});

// ---------------------------------------------------------------------------
// W4.5: run_workflow over MCP with a missing required input must return ONE
// terminal, actionable `needs_input` envelope naming the fields — never an
// orphan `awaiting_input` + unresolvable elicitation_id the client can loop
// on (the ChatGPT canvas-spiral trigger).
// ---------------------------------------------------------------------------

describe("MCP tools/call — run_workflow missing required input (W4.5 anti-spiral)", () => {
  test("returns a single terminal needs_input envelope naming the missing field", async () => {
    const slug = "needs-input-city-wf";
    // The `${input.city}` placeholder synthesizes a required `city` input,
    // so a run with no input pauses on the missing-input gate.
    const createRes = await journeyFetch(ctx, "/v1/workflows", {
      method: "POST",
      body: JSON.stringify({
        name: "Needs Input City WF",
        slug,
        steps: [
          {
            kind: "request",
            id: "probe",
            method: "GET",
            url: `${mockBase}/test?city=\${input.city}`,
          },
        ],
      }),
    });
    expect(createRes.status).toBeLessThan(300);

    const client = await connect();
    try {
      const result = await client.callTool({
        name: "run_workflow",
        // Explicit dev environment is no_confirm (the policy reads the raw
        // arg, not the tool's schema default), so the call reaches the tool
        // body and hits the missing-input gate — no confirm detour.
        arguments: { workflow: slug, environment: "dev" },
      });
      // Terminal + actionable — NOT an isError hard-fail, and NOT a silent
      // loop.
      expect(result.isError).toBeFalsy();
      const textBlocks = (result.content as Array<{ type: string; text?: string }>).filter(
        (b) => b.type === "text",
      );
      // A SINGLE terminal block — no ambiguity for the client to spiral on.
      expect(textBlocks.length).toBe(1);
      const body = JSON.parse(textBlocks[0]!.text!) as {
        status: string;
        error_code: string;
        message: string;
        missing_fields: string[];
        fields: Array<{ name: string }>;
      };
      expect(body.status).toBe("needs_input");
      expect(body.error_code).toBe("missing_input");
      // The envelope NAMES the exact missing field inline (a text-only
      // client that ignores _meta can still act in one step).
      expect(body.missing_fields).toContain("city");
      expect(body.message).toContain("city");
      expect(body.fields.map((f) => f.name)).toContain("city");
      // No unresolvable orphan elicitation leaked to the client.
      expect(body.status).not.toBe("awaiting_input");
      expect(textBlocks[0]!.text!).not.toContain("elicitation_id");
    } finally {
      await client.close();
    }
  });
});
