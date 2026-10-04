import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("streamable-http-stale-session");
});

afterAll(async () => {
  await suite.cleanup();
});

describe("streamable-http transport — unknown mcp-session-id", () => {
  test("a non-initialize request with an unknown session id returns 404 + JSON-RPC error, not a hang", async () => {
    const res = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${suite.http.apiKey}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": "00000000-dead-beef-0000-000000000000",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      jsonrpc: string;
      error?: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe("2.0");
    expect(body.error?.code).toBe(-32001);
    expect(body.error?.message).toBe("Session not found");
  });
});
