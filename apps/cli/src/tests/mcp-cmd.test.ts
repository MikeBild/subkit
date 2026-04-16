// `subkit mcp` stdio transport smoke.
//
// Spawns the CLI under bun as an MCP server over stdio (the same way an
// IDE would launch it), connects an MCP Client via StdioClientTransport,
// and asserts that tools/list returns the seeded `ping` tool. We point
// the CLI at a throwaway Hono server so the engine_url surfaces in the
// tool description, proving the env propagation also works.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_ENTRY = path.resolve(HERE, "..", "index.ts");

let mockEngine: Server;
let mockEngineUrl: string;

beforeAll(async () => {
  mockEngine = createServer((_req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: "ok" }));
  });
  await new Promise<void>((resolve) => mockEngine.listen(0, "127.0.0.1", () => resolve()));
  const addr = mockEngine.address() as AddressInfo;
  mockEngineUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => mockEngine.close(() => resolve()));
});

describe("subkit mcp stdio transport", () => {
  test("tools/list returns the ping tool", async () => {
    const transport = new StdioClientTransport({
      command: "bun",
      args: [CLI_ENTRY, "mcp", "--engine-url", mockEngineUrl, "--api-key", "wf_test_dummy"],
      env: {
        // Keep the child env minimal so we don't inherit a stray
        // SUBKIT_* var from the parent test process.
        PATH: process.env.PATH ?? "",
        SUBKIT_ENGINE_URL: mockEngineUrl,
        SUBKIT_API_KEY: "wf_test_dummy",
      },
      stderr: "pipe",
    });

    const client = new Client({ name: "subkit-mcp-test", version: "0.0.0" }, { capabilities: {} });

    try {
      await client.connect(transport);
      const tools = (await client.listTools()) as {
        tools: Array<{ name: string; description?: string }>;
      };
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("ping");
      const ping = tools.tools.find((t) => t.name === "ping");
      expect(ping?.description ?? "").toContain(mockEngineUrl);
    } finally {
      await client.close().catch(() => {});
    }
  }, 30_000);
});
