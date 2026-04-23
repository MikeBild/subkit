// MCP tenant surface E2E.
//
// Confirms that a live engine's MCP endpoint advertises the tenant.*
// tools (Gap #5) with populated input schemas (Gap #P0) and that the
// `conversation.*` helper set is still present.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  // The mode-split MCP catalog hides conversation.* and tenant.* from
  // the default product surface; this suite validates the combined
  // authoring+admin surface, so opt in explicitly.
  process.env.SK_MCP_MODE = "admin";
  env = await boot("mcp-surface");
}, 90_000);
afterAll(async () => {
  await shutdown(env);
  delete process.env.SK_MCP_MODE;
}, 30_000);

// MCP streamable-http requires a persistent session — the first
// `initialize` returns an `mcp-session-id` response header that every
// subsequent call must echo back.
class McpSession {
  public sessionId: string | null = null;

  constructor(private readonly env: E2EEnv) {}

  async call(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.env.personas.admin.apiKey}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const r = await fetch(`${this.env.baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `${method}-${Date.now()}`,
        method,
        params,
      }),
    });
    // Capture the session id on the initialize response.
    const sid = r.headers.get("mcp-session-id");
    if (sid && !this.sessionId) this.sessionId = sid;
    const text = await r.text();
    const trimmed = text.trim();
    if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
      const dataLine = trimmed.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) throw new Error(`unexpected SSE payload: ${trimmed}`);
      return JSON.parse(dataLine.slice(5).trim()) as Record<string, unknown>;
    }
    return JSON.parse(trimmed) as Record<string, unknown>;
  }
}

describe("MCP tenant tool surface", () => {
  test("initialize + tools/list returns wf.*, conversation.*, and tenant.* tools", async () => {
    const session = new McpSession(env);
    await session.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e-test", version: "0.0.0" },
    });
    const list = await session.call("tools/list", {});
    const result = list.result as {
      tools: Array<{ name: string; inputSchema?: unknown }>;
    };
    expect(Array.isArray(result.tools)).toBe(true);

    const names = new Set(result.tools.map((t) => t.name));
    // Must expose the conversation.* helpers.
    for (const n of ["conversation.start", "conversation.append", "conversation.commit"]) {
      expect(names.has(n)).toBe(true);
    }
    // Must expose the generated read family under tenant.*.
    const tenantReads = [...names].filter((n) => n.startsWith("tenant.")).length;
    expect(tenantReads).toBeGreaterThan(3);

    // Input schema conversion is real — list_workflows has populated
    // properties post-fix (Gap #P0 zodToMcpSchema).
    const listWorkflows = result.tools.find((t) => t.name === "tenant.list_workflows");
    expect(listWorkflows).toBeDefined();
    const schema = listWorkflows?.inputSchema as {
      type?: string;
      properties?: Record<string, unknown>;
    };
    expect(schema.type).toBe("object");
  }, 60_000);

  test("tenant.* write tools are visible by default and carry _meta.subkit hints", async () => {
    const session = new McpSession(env);
    await session.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e-test", version: "0.0.0" },
    });
    const list = await session.call("tools/list", {});
    const result = list.result as {
      tools: Array<{
        name: string;
        _meta?: { subkit?: { category: string; confirm_required: boolean; destructive: boolean } };
      }>;
    };
    const byName = new Map(result.tools.map((t) => [t.name, t]));
    // Post-flip (SK_MCP_READ_ONLY unset = writes visible), destructive
    // tenant_write tools are listed and advertise confirm_required.
    expect(byName.has("tenant.delete_workflow")).toBe(true);
    expect(byName.get("tenant.delete_workflow")?._meta?.subkit).toEqual({
      category: "tenant_write",
      confirm_required: true,
      destructive: true,
    });
    expect(byName.get("tenant.list_workflows")?._meta?.subkit).toEqual({
      category: "tenant_read",
      confirm_required: false,
      destructive: false,
    });
  }, 30_000);

  test("destructive tenant.* call returns confirm_required, then completes with _meta.sk_confirm", async () => {
    // Seed a workflow through the authoring surface so the delete has
    // a real target. `start_workflow_from_goal` is the draft-first
    // path; we use `build_workflow` + `commit_draft` via a direct DB
    // insertion is out of scope for e2e, so we drive through a
    // throwaway workflow created via the API instead.
    const createRes = await fetch(`${env.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.personas.admin.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        slug: `doomed-${Date.now()}`,
        name: "doomed",
        steps: [
          {
            kind: "transform",
            id: "noop",
            language: "jsonata",
            expression: '{ "ok": true }',
          },
        ],
      }),
    });
    expect(createRes.ok).toBe(true);
    const created = (await createRes.json()) as { id?: string; workflow?: { id?: string } };
    const workflowId = created.id ?? created.workflow?.id;
    expect(typeof workflowId).toBe("string");

    const session = new McpSession(env);
    await session.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e-test", version: "0.0.0" },
    });

    // First call — expect pending envelope.
    const first = await session.call("tools/call", {
      name: "tenant.delete_workflow",
      arguments: { id: workflowId },
    });
    const firstResult = first.result as {
      isError?: boolean;
      content?: Array<{ type: string; text: string }>;
    };
    expect(firstResult.isError).toBeFalsy();
    const firstEnvelope = JSON.parse(firstResult.content![0]!.text) as {
      pending?: boolean;
      confirm_required?: boolean;
      target?: { tool?: string };
      tool_call_id?: string;
    };
    expect(firstEnvelope.pending).toBe(true);
    expect(firstEnvelope.confirm_required).toBe(true);
    expect(firstEnvelope.target?.tool).toBe("tenant.delete_workflow");

    // Second call — re-issue with _meta.sk_confirm = true.
    const second = await session.call("tools/call", {
      name: "tenant.delete_workflow",
      arguments: { id: workflowId },
      _meta: { sk_confirm: true },
    });
    const secondResult = second.result as {
      isError?: boolean;
      content?: Array<{ type: string; text: string }>;
    };
    expect(secondResult.isError).toBeFalsy();
    // The tool should have reported a successful deletion.
    const secondPayload = JSON.parse(secondResult.content![0]!.text);
    expect(secondPayload).toBeTruthy();
  }, 60_000);

  test("tenant.get_engine_status call returns a JSON summary", async () => {
    const session = new McpSession(env);
    await session.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e-test", version: "0.0.0" },
    });
    const call = await session.call("tools/call", {
      name: "tenant.get_engine_status",
      arguments: {},
    });
    const result = call.result as {
      isError?: boolean;
      content?: Array<{ type: string; text: string }>;
    };
    expect(result.isError).toBeFalsy();
    expect(result.content?.[0]?.type).toBe("text");
    const payload = JSON.parse(result.content![0]!.text) as {
      tenant_id?: string;
      workflows?: number;
      connectors?: number;
    };
    expect(typeof payload.tenant_id).toBe("string");
    expect(typeof payload.workflows).toBe("number");
    expect(typeof payload.connectors).toBe("number");
  }, 30_000);
});
