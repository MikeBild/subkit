// MCP tool surface E2E.
//
// Confirms that a live engine's MCP endpoint advertises the conversation
// tools under their bare names with populated input schemas, that the
// `conversation_*` helper set is present, and that destructive writes go
// through the unified dispatcher's confirm gate. The legacy `tenant_*`
// prefix aliases were removed — every tool surfaces under its bare name.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { skills } from "../../apps/engine/src/db/schema/index.ts";
import { getTestNow } from "../../apps/engine/src/test-helpers/determinism/clock.ts";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

const TEST_NOW_MS = getTestNow();
const MCP_PROTOCOL_VERSION = "2025-11-25";

let env: E2EEnv;
beforeAll(async () => {
  // The mode-split MCP catalog hides conversation tools + tenant writes
  // from the default product surface; this suite validates the combined
  // authoring+admin surface, so opt in explicitly.
  process.env.SK_MCP_MODE = "admin";
  env = await boot("mcp-surface", { llm: "mock" });
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
    if (this.sessionId) {
      headers["mcp-session-id"] = this.sessionId;
      headers["MCP-Protocol-Version"] = MCP_PROTOCOL_VERSION;
    }
    const r = await fetch(`${this.env.baseUrl}/mcp`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: `${method}-${TEST_NOW_MS}`,
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

  async listAllTools(): Promise<
    Array<{
      name: string;
      title?: string;
      inputSchema?: unknown;
      execution?: { taskSupport?: string };
      _meta?: { subkit?: { category: string; confirm_required: boolean; destructive: boolean } };
    }>
  > {
    const tools: Array<{
      name: string;
      title?: string;
      inputSchema?: unknown;
      execution?: { taskSupport?: string };
      _meta?: { subkit?: { category: string; confirm_required: boolean; destructive: boolean } };
    }> = [];
    let cursor: string | undefined;
    do {
      const list = await this.call("tools/list", cursor ? { cursor } : {});
      const result = list.result as {
        tools: typeof tools;
        nextCursor?: string;
      };
      tools.push(...result.tools);
      cursor = result.nextCursor;
    } while (cursor);
    return tools;
  }
}

describe("MCP tool surface", () => {
  test("initialize negotiates 2025-11-25 and advertises only supported capabilities", async () => {
    const session = new McpSession(env);
    const init = await session.call("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "e2e-test", version: "0.0.0" },
    });
    const result = init.result as {
      protocolVersion?: string;
      serverInfo?: { name?: string; version?: string };
      capabilities?: Record<string, unknown>;
      instructions?: string;
    };
    expect(result.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    expect(result.serverInfo?.name).toBe("subkit-engine");
    expect(result.capabilities?.tools).toBeTruthy();
    expect(result.capabilities?.resources).toBeTruthy();
    expect(result.capabilities?.prompts).toBeTruthy();
    expect(result.capabilities?.tasks).toBeTruthy();
    expect(result.capabilities?.sampling).toBeUndefined();
    expect(result.capabilities?.roots).toBeUndefined();
    expect(result.instructions).toContain("conversation_start");
  }, 30_000);

  test("raw HTTP guards reject invalid origin and unsupported protocol version", async () => {
    const invalidOrigin = await fetch(`${env.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        origin: "https://evil.example",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "bad-origin",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "e2e-test", version: "0.0.0" },
        },
      }),
    });
    expect(invalidOrigin.status).toBe(403);

    const invalidVersion = await fetch(`${env.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.personas.admin.apiKey}`,
        "MCP-Protocol-Version": "1900-01-01",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "bad-version",
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "e2e-test", version: "0.0.0" },
        },
      }),
    });
    expect(invalidVersion.status).toBe(400);
  }, 30_000);

  test("initialize + tools/list returns conversation_* + bare tools, and NO tenant_* aliases", async () => {
    const session = new McpSession(env);
    await session.call("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "e2e-test", version: "0.0.0" },
    });
    const tools = await session.listAllTools();
    expect(Array.isArray(tools)).toBe(true);

    const names = new Set(tools.map((t) => t.name));
    // Must expose the conversation_* helpers.
    for (const n of ["conversation_start", "conversation_append", "conversation_commit"]) {
      expect(names.has(n)).toBe(true);
    }
    // Read family surfaces under bare names (admin mode).
    const bareReads = ["list_workflows", "list_connectors", "get_engine_status"].filter((n) =>
      names.has(n),
    ).length;
    expect(bareReads).toBeGreaterThan(2);
    // The legacy tenant_* alias surface is gone.
    expect([...names].filter((n) => n.startsWith("tenant_")).length).toBe(0);

    // Input schema conversion is real — list_workflows has a populated
    // object schema via zodToMcpSchema.
    const listWorkflows = tools.find((t) => t.name === "list_workflows");
    expect(listWorkflows).toBeDefined();
    // `title` is the human-readable label derived Title-Case from the
    // snake_case `name` (titleFromName in adapter.ts) — MCP clients render
    // `title` and fall back to `name` only when it is absent.
    expect(listWorkflows?.title).toBe("List Workflows");
    expect(listWorkflows?.execution?.taskSupport).toBe("forbidden");
    const schema = listWorkflows?.inputSchema as {
      type?: string;
      properties?: Record<string, unknown>;
    };
    expect(schema.type).toBe("object");

    const conversationStart = tools.find((t) => t.name === "conversation_start");
    expect(conversationStart?.execution?.taskSupport).toBe("optional");
  }, 60_000);

  test("write tools are visible by default and carry _meta.subkit hints", async () => {
    const session = new McpSession(env);
    await session.call("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "e2e-test", version: "0.0.0" },
    });
    const tools = await session.listAllTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    // Writes visible (SK_MCP_READ_ONLY unset); destructive tenant_write
    // tools advertise confirm_required via _meta.subkit.
    expect(byName.has("delete_workflow")).toBe(true);
    expect(byName.get("delete_workflow")?._meta?.subkit).toEqual({
      category: "tenant_write",
      confirm_required: true,
      destructive: true,
    });
    expect(byName.get("list_workflows")?._meta?.subkit).toEqual({
      category: "tenant_read",
      confirm_required: false,
      destructive: false,
    });
  }, 30_000);

  test("destructive call returns needs_confirm, then completes with _meta.sk_confirm", async () => {
    // Seed a workflow so the delete has a real target. Driving the full
    // authoring surface is out of scope here, so create one via the API.
    const createRes = await fetch(`${env.baseUrl}/v1/workflows`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.personas.admin.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        slug: `doomed-${TEST_NOW_MS}`,
        name: "doomed",
        steps: [
          {
            kind: "transform",
            id: "noop",
            language: "javascript",
            expression: "return { ok: true };",
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
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "e2e-test", version: "0.0.0" },
    });

    // First call — expect a needs_confirm envelope from the unified
    // dispatcher (rendered as isError:false with the ConfirmEnvelope JSON).
    const first = await session.call("tools/call", {
      name: "delete_workflow",
      arguments: { id: workflowId },
    });
    const firstResult = first.result as {
      isError?: boolean;
      content?: Array<{ type: string; text: string }>;
    };
    expect(firstResult.isError).toBeFalsy();
    const confirm = JSON.parse(firstResult.content![0]!.text) as {
      tool?: string;
      policy_mode?: string;
      tool_call_id?: string;
    };
    expect(confirm.tool).toBe("delete_workflow");
    expect(confirm.policy_mode).toBe("confirm_before_execution");
    expect(typeof confirm.tool_call_id).toBe("string");

    // Second call — re-issue with _meta.sk_confirm = true (carry the id so
    // the approval is audited).
    const second = await session.call("tools/call", {
      name: "delete_workflow",
      arguments: { id: workflowId },
      _meta: { sk_confirm: true, sk_confirm_id: confirm.tool_call_id },
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

  test("get_engine_status call returns a JSON summary", async () => {
    const session = new McpSession(env);
    await session.call("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "e2e-test", version: "0.0.0" },
    });
    const call = await session.call("tools/call", {
      name: "get_engine_status",
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

  test("resources/templates/list and prompts/get with arguments work on the live endpoint", async () => {
    const [skill] = await env.db
      .insert(skills)
      .values({
        tenant_id: env.tenantId,
        scope: "global",
        title: "E2E prompted greeting",
        body: "Hello {{name}} from {{place}}.",
        examples: ["Example for {{name}}."],
        arguments: [
          { name: "name", description: "Person name", required: true },
          { name: "place", description: "Place name" },
        ],
        lifecycle: "active",
        version: 1,
      })
      .returning({ id: skills.id });
    if (!skill) throw new Error("failed to seed prompt skill");

    const session = new McpSession(env);
    await session.call("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "e2e-test", version: "0.0.0" },
    });

    const templates = await session.call("resources/templates/list", {});
    const templateResult = templates.result as {
      resourceTemplates: Array<{ uriTemplate: string; title?: string }>;
    };
    const uriTemplates = new Set(templateResult.resourceTemplates.map((t) => t.uriTemplate));
    expect(uriTemplates.has("workflow://{id}")).toBe(true);
    expect(uriTemplates.has("connector://{id}")).toBe(true);
    expect(uriTemplates.has("fixture://{id}")).toBe(true);

    const prompts = await session.call("prompts/list", {});
    const promptResult = prompts.result as {
      prompts: Array<{ name: string; title?: string; arguments?: Array<{ name: string }> }>;
    };
    const prompt = promptResult.prompts.find((p) => p.name === `skill_${skill.id}`);
    expect(prompt?.title).toBe("E2E prompted greeting");
    expect(prompt?.arguments?.map((a) => a.name)).toEqual(["name", "place"]);

    const got = await session.call("prompts/get", {
      name: `skill_${skill.id}`,
      arguments: { name: "Ada", place: "MCP" },
    });
    const gotResult = got.result as {
      messages: Array<{ role: string; content: { type: string; text: string } }>;
    };
    expect(gotResult.messages[0]?.content.text).toBe("Hello Ada from MCP.");
    expect(gotResult.messages[1]?.content.text).toBe("Example for Ada.");
  }, 30_000);
});
