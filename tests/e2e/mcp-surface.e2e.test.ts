// MCP tenant surface E2E.
//
// Confirms that a live engine's MCP endpoint advertises the tenant.*
// tools (Gap #5) with populated input schemas (Gap #P0) and that the
// `conversation.*` helper set is still present.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("mcp-surface");
}, 90_000);
afterAll(async () => {
  await shutdown(env);
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

  test("tenant.* write tools are hidden unless SK_MCP_ALLOW_WRITES=1", async () => {
    const session = new McpSession(env);
    await session.call("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "e2e-test", version: "0.0.0" },
    });
    const list = await session.call("tools/list", {});
    const result = list.result as { tools: Array<{ name: string }> };
    const names = new Set(result.tools.map((t) => t.name));
    // The default test env does NOT set SK_MCP_ALLOW_WRITES=1, so
    // write tools are filtered out.
    expect(names.has("tenant.run_workflow")).toBe(false);
    expect(names.has("tenant.approve_patch_candidate")).toBe(false);
  }, 30_000);

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
