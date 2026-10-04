import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

const MCP_PROTOCOL_VERSION = "2025-11-25";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("streamable-http-sse-conflict");
});

afterAll(async () => {
  await suite.cleanup();
});

async function initialize(): Promise<string> {
  const res = await fetch(`${suite.http.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${suite.http.apiKey}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "init",
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "sse-conflict-test", version: "0.0.0" },
      },
    }),
  });
  expect(res.status).toBe(200);
  await res.text();
  const sessionId = res.headers.get("mcp-session-id");
  expect(typeof sessionId).toBe("string");
  return sessionId!;
}

function openStandaloneStream(sessionId: string): Promise<Response> {
  return fetch(`${suite.http.baseUrl}/mcp`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${suite.http.apiKey}`,
      accept: "text/event-stream",
      "mcp-session-id": sessionId,
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    },
  });
}

describe("streamable-http transport — standalone GET SSE stream", () => {
  test("a second GET on the same session replaces the first instead of 409ing", async () => {
    const sessionId = await initialize();

    const first = await openStandaloneStream(sessionId);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/event-stream");

    const second = await openStandaloneStream(sessionId);
    expect(second.status).toBe(200);
    expect(second.headers.get("content-type")).toContain("text/event-stream");

    await first.body?.cancel();
    await second.body?.cancel();
  });
});
