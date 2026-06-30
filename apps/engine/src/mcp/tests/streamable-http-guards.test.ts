import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("streamable-http-guards");
});

afterAll(async () => {
  await suite.cleanup();
});

function initializeBody(id = 1): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "guard-test", version: "0.0.0" },
    },
  });
}

describe("streamable-http transport guards", () => {
  test("rejects an invalid Origin header with 403 before auth", async () => {
    const res = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        origin: "https://evil.example.test",
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: initializeBody(),
    });

    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("invalid Origin");
  });

  test("allows same-origin requests and then applies the normal auth challenge", async () => {
    const res = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        origin: suite.http.baseUrl,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: initializeBody(),
    });

    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('scope="mcp:read"');
  });

  test("rejects unsupported MCP-Protocol-Version with 400", async () => {
    const res = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${suite.http.apiKey}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "1999-01-01",
      },
      body: initializeBody(),
    });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: { message?: string } };
    expect(body.error?.message).toContain("Unsupported protocol version");
  });

  test("accepts the current MCP protocol version header on initialize", async () => {
    const res = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${suite.http.apiKey}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": LATEST_PROTOCOL_VERSION,
      },
      body: initializeBody(),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
  });
});
