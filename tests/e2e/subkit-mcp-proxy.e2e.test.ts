import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SUBKIT_BIN } from "./_helpers/pty.ts";
import { boot, type E2EEnv, shutdown } from "./setup.ts";

const REPO_ROOT = path.resolve(import.meta.dir, "../..");

let env: E2EEnv;
beforeAll(async () => {
  env = await boot("subkit-mcp-proxy", { llm: "mock" });
}, 90_000);

afterAll(async () => {
  await shutdown(env);
}, 30_000);

function proxyEnv(persona: E2EEnv["personas"]["admin"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    ...process.env,
    CI: "1",
    NO_COLOR: "1",
    NO_UPDATE_CHECK: "1",
    HOME: persona.homeDir,
    XDG_CONFIG_HOME: persona.homeDir,
    SUBKIT_DETERMINISTIC_SEED: process.env.SUBKIT_DETERMINISTIC_SEED ?? "1",
  })) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function connectProxy(): Promise<Client> {
  const client = new Client({ name: "subkit-mcp-proxy-e2e", version: "0.0.0" });
  const transport = new StdioClientTransport({
    command: SUBKIT_BIN,
    args: [
      "mcp",
      "--engine-url",
      env.baseUrl,
      "--api-key",
      env.personas.admin.apiKey,
      "--tenant",
      env.tenantId,
    ],
    cwd: REPO_ROOT,
    env: proxyEnv(env.personas.admin),
    stderr: "pipe",
  });
  await client.connect(transport);
  return client;
}

function textContent(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const first = result.content[0];
  if (first?.type !== "text") throw new Error("expected text MCP content");
  return first.text;
}

describe("subkit mcp stdio proxy", () => {
  test("handshake advertises the expected capability snapshot and tool metadata", async () => {
    const client = await connectProxy();
    try {
      expect(client.getServerVersion()?.name).toBe("subkit-cli");
      expect(client.getServerCapabilities()?.tools).toBeTruthy();
      expect(client.getServerCapabilities()?.resources).toBeUndefined();
      expect(client.getServerCapabilities()?.prompts).toBeUndefined();
      expect(client.getServerCapabilities()?.sampling).toBeUndefined();

      const list = await client.listTools();
      const byName = new Map(list.tools.map((tool) => [tool.name, tool]));
      expect([...byName.keys()]).toEqual([
        "subkit_ping",
        "subkit_conversation_create",
        "subkit_conversation_append",
        "subkit_conversation_get",
        "subkit_conversation_list",
      ]);
      const MCP_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
      for (const tool of byName.values()) {
        expect(tool.name).toMatch(MCP_TOOL_NAME);
        expect(tool.title).toBe(tool.name);
        expect(tool.inputSchema.type).toBe("object");
        expect(tool.inputSchema.additionalProperties).toBe(false);
        expect(tool.execution?.taskSupport).toBe("forbidden");
      }
    } finally {
      await client.close();
    }
  }, 30_000);

  test("callTool covers ping and the conversation proxy helpers", async () => {
    const client = await connectProxy();
    try {
      const ping = await client.callTool({ name: "subkit_ping", arguments: {} });
      expect(textContent(ping)).toContain(
        `engine=${env.baseUrl} live=ok ready=ready database=pass`,
      );

      const created = await client.callTool({
        name: "subkit_conversation_create",
        arguments: { title: "stdio proxy e2e" },
      });
      expect(created.isError).toBeFalsy();
      const createPayload = JSON.parse(textContent(created)) as {
        conversation?: { id?: string; title?: string };
      };
      const conversationId = createPayload.conversation?.id;
      expect(typeof conversationId).toBe("string");
      expect(createPayload.conversation?.title).toBe("stdio proxy e2e");

      const appended = await client.callTool({
        name: "subkit_conversation_append",
        arguments: { conversation_id: conversationId, message: "Summarize the current surface." },
      });
      expect(appended.isError).toBeFalsy();

      const detail = await client.callTool({
        name: "subkit_conversation_get",
        arguments: { conversation_id: conversationId },
      });
      const detailPayload = JSON.parse(textContent(detail)) as {
        conversation?: { id?: string };
        messages?: unknown[];
      };
      expect(detailPayload.conversation?.id).toBe(conversationId);
      expect(Array.isArray(detailPayload.messages)).toBe(true);

      const listed = await client.callTool({
        name: "subkit_conversation_list",
        arguments: { limit: 5 },
      });
      const listPayload = JSON.parse(textContent(listed)) as {
        items?: Array<{ id?: string }>;
      };
      expect(listPayload.items?.some((item) => item.id === conversationId)).toBe(true);

      const unknown = await client.callTool({ name: "subkit_unknown", arguments: {} });
      expect(unknown.isError).toBe(true);
      expect(textContent(unknown)).toContain("unknown tool: subkit_unknown");
    } finally {
      await client.close();
    }
  }, 60_000);

  test("missing login exits before exposing a stdio server", async () => {
    const envVars = proxyEnv(env.personas.admin);
    envVars.SUBKIT_API_KEY = "";
    envVars.SUBKIT_ENGINE_URL = env.baseUrl;
    envVars.SUBKIT_TENANT = env.tenantId;
    const proc = Bun.spawn(
      [SUBKIT_BIN, "mcp", "--engine-url", env.baseUrl, "--tenant", env.tenantId],
      {
        cwd: REPO_ROOT,
        env: envVars,
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(stdout).toBe("");
    expect(exitCode).toBe(2);
    expect(stderr).toContain("not logged in");
  }, 30_000);
});
