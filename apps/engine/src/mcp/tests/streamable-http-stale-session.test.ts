// Stale / unknown `mcp-session-id` handling.
//
// `transports/streamable-http.ts` caches per-session transports in a
// process-local Map. When a client sends a request carrying an
// `mcp-session-id` this process does not have (engine restart dropped the
// map, or the session was already closed), the handler must answer 404 per
// the MCP Streamable HTTP spec so the client re-runs the `initialize`
// handshake — and must NOT fall through to build a throwaway transport that
// self-rejects with "Server not initialized" (logged at `warn`). That noise
// is exactly what the 404 short-circuit (logged at `debug`,
// `action: "mcp.session.stale"`) replaces.

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
        // A session id this freshly-started suite has never issued.
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
