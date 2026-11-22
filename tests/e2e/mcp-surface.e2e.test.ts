import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { z } from "zod";
import { issueBrowserSession } from "../../apps/engine/src/auth/browser-session.ts";
import { skills } from "../../apps/engine/src/db/schema/index.ts";
import { getTestNow } from "../../apps/engine/src/test-helpers/determinism/clock.ts";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

const TEST_NOW_MS = getTestNow();
const MCP_PROTOCOL_VERSION = "2025-11-25";

let env: E2EEnv;
beforeAll(async () => {
  process.env.SUBKIT_MCP_MODE = "admin";
  env = await boot("mcp-surface", { llm: "mock" });
}, 90_000);
afterAll(async () => {
  await shutdown(env);
  delete process.env.SUBKIT_MCP_MODE;
}, 30_000);

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
    for (const n of ["conversation_start", "conversation_append", "conversation_commit"]) {
      expect(names.has(n)).toBe(true);
    }
    const bareReads = ["list_workflows", "list_connectors", "get_engine_status"].filter((n) =>
      names.has(n),
    ).length;
    expect(bareReads).toBeGreaterThan(2);
    expect([...names].filter((n) => n.startsWith("tenant_")).length).toBe(0);

    const listWorkflows = tools.find((t) => t.name === "list_workflows");
    expect(listWorkflows).toBeDefined();
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

  test("destructive call waits for a local human decision and replays the exact call once", async () => {
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

    const call = await session.call("tools/call", {
      name: "delete_workflow",
      arguments: { id: workflowId },
    });
    const callResult = call.result as {
      isError?: boolean;
      content?: Array<{ type: string; text: string }>;
    };
    expect(callResult.isError).toBeFalsy();
    const payload = z
      .object({
        status: z.literal("needs_confirm"),
        tool_call_id: z.uuid(),
        approval_url: z.url(),
      })
      .parse(JSON.parse(callResult.content![0]!.text));

    const readTarget = () =>
      fetch(`${env.baseUrl}/v1/workflows/${workflowId}`, {
        headers: { authorization: `Bearer ${env.personas.admin.apiKey}` },
      });
    expect((await readTarget()).status).toBe(200);
    const resume = () =>
      session.call("tools/call", {
        name: "confirm_tool_call",
        arguments: { tool: "delete_workflow", confirm_id: payload.tool_call_id },
      });
    const premature = await resume();
    expect((premature.result as { isError?: boolean }).isError).toBe(true);
    expect(JSON.stringify(premature.result)).toContain("approval_not_granted");
    expect((await readTarget()).status).toBe(200);

    const login = await issueBrowserSession({
      db: env.db,
      tenantId: env.tenantId,
      userId: env.personas.admin.userId,
      redirectTo: payload.approval_url,
      via: "mcp_surface_e2e",
    });
    const cookie = login.headers.get("set-cookie") ?? "";
    expect(cookie).not.toBe("");
    const page = await fetch(payload.approval_url, { headers: { cookie } });
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain("delete_workflow");
    const csrf = /name="csrf_token" value="([^"]+)"/.exec(html)?.[1];
    expect(csrf).toBeTruthy();
    const decision = await fetch(`${env.baseUrl}/v1/tool-approvals/decide`, {
      method: "POST",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant: new URL(payload.approval_url).searchParams.get("grant") ?? "",
        decision: "approve",
        csrf_token: csrf ?? "",
      }),
    });
    expect(decision.status).toBe(200);
    expect((await readTarget()).status).toBe(200);
    const replay = await resume();
    expect((replay.result as { isError?: boolean }).isError).toBeFalsy();

    expect((await readTarget()).status).toBe(404);
    const duplicate = await resume();
    expect((duplicate.result as { isError?: boolean }).isError).toBe(true);
    expect((await readTarget()).status).toBe(404);
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
