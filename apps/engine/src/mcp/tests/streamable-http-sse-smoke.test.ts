import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMockServer, jsonResponse, type MockServer } from "../../execution/tests/setup.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;
let mock: MockServer;

beforeAll(async () => {
  suite = await startMcpTestSuite("streamable-http-sse-smoke");
  mock = await createMockServer((_req, res) => {
    jsonResponse(res, 200, { ok: true });
  });
});

afterAll(async () => {
  await mock.close();
  await suite.cleanup();
});

describe("streamable-http transport — SSE-framed envelope (non-elicitation client)", () => {
  test("initialize → tools/list → tools/call all parse over the SSE-framed transport", async () => {
    await suite.seedWorkflow({
      name: "sse smoke",
      slug: "sse-smoke",
      steps: [
        {
          kind: "request",
          id: "u",
          method: "GET",
          url: `${mock.baseUrl}/ping`,
        },
      ],
    });

    const client = await suite.connect();

    const listed = await client.listTools();
    expect(Array.isArray(listed.tools)).toBe(true);
    expect(listed.tools.length).toBeGreaterThan(0);
    expect(listed.tools.some((t) => t.name === "wf_sse-smoke")).toBe(true);

    const called = await client.callTool({ name: "wf_sse-smoke", arguments: {} });
    expect(called.isError).toBeFalsy();
    const content = called.content as Array<{ type: string; text: string }>;
    expect(content.length).toBe(1);
    expect(content[0]?.type).toBe("text");
    const parsed = JSON.parse(content[0]!.text) as { ok: boolean };
    expect(parsed.ok).toBe(true);
  });

  test("a Client built WITHOUT the elicitation capability drives the same chain over SSE framing", async () => {
    await suite.seedWorkflow({
      name: "sse smoke no-elicit",
      slug: "sse-smoke-no-elicit",
      steps: [
        {
          kind: "request",
          id: "u",
          method: "GET",
          url: `${mock.baseUrl}/ping`,
        },
      ],
    });

    const transport = new StreamableHTTPClientTransport(new URL(`${suite.http.baseUrl}/mcp`), {
      requestInit: {
        headers: { authorization: `Bearer ${suite.http.apiKey}` },
      },
    });
    const client = new Client(
      { name: "subkit-mcp-tests-no-elicit", version: "0.0.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport as unknown as Transport);

      const listed = await client.listTools();
      expect(Array.isArray(listed.tools)).toBe(true);
      expect(listed.tools.some((t) => t.name === "wf_sse-smoke-no-elicit")).toBe(true);

      const called = await client.callTool({
        name: "wf_sse-smoke-no-elicit",
        arguments: {},
      });
      expect(called.isError).toBeFalsy();
      const content = called.content as Array<{ type: string; text: string }>;
      expect(content.length).toBe(1);
      expect(content[0]?.type).toBe("text");
      const parsed = JSON.parse(content[0]!.text) as { ok: boolean };
      expect(parsed.ok).toBe(true);
    } finally {
      await client.close();
    }
  });
});
