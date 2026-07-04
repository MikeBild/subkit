// Streamable-HTTP standalone-GET-stream conflict handling.
//
// The SDK transport permits exactly ONE standalone GET SSE stream per session
// (the server→client notification channel) and 409s a second one. A client
// that re-opens that channel after a network blip — before the server observed
// the old socket close — would otherwise get a Conflict it cannot recover from
// and lose notifications for the rest of the session. `transports/streamable-
// http.ts` pre-empts any stale standalone stream on a new GET so the reconnect
// REPLACES it (last-writer-wins) instead of conflicting.
//
// This exercises the raw HTTP/SSE envelope because the SDK Client hides the
// standalone GET stream behind its own reconnection logic. Full multi-tab
// browser reconnection still needs the chrome MCP e2e; this pins the transport
// contract deterministically.

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
  // Drain the SSE-framed initialize response so the socket is released.
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

    // First notification stream — leave it open (do not drain the body).
    const first = await openStandaloneStream(sessionId);
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("text/event-stream");

    // A reconnect: second GET on the SAME session. Pre-fix this returned a
    // 409 Conflict; the pre-empt makes it a fresh 200.
    const second = await openStandaloneStream(sessionId);
    expect(second.status).toBe(200);
    expect(second.headers.get("content-type")).toContain("text/event-stream");

    // Release both stream bodies so the test DB/server can close cleanly.
    await first.body?.cancel();
    await second.body?.cancel();
  });
});
