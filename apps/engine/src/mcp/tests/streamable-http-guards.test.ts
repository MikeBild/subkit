import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { __test__ as guardsTest } from "../transports/guards.ts";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("streamable-http-guards");
});

afterAll(async () => {
  await suite.cleanup();
});

function initializeBody(id: number | string = 1): string {
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

async function initSession(): Promise<string> {
  const res = await fetch(`${suite.http.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${suite.http.apiKey}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: initializeBody(),
  });
  expect(res.status).toBe(200);
  await res.text();
  const sessionId = res.headers.get("mcp-session-id");
  expect(typeof sessionId).toBe("string");
  return sessionId!;
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
    expect(res.headers.get("www-authenticate")).toContain(
      'scope="mcp:read mcp:authoring mcp:admin"',
    );
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

describe("streamable-http session lifecycle and wire shape", () => {
  test("POST without Mcp-Session-Id on non-initialize method returns 400", async () => {
    const res = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${suite.http.apiKey}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    await res.text();
    expect(res.status).toBe(400);
  });

  test("DELETE /mcp terminates the session; follow-up POST with the same session id returns 404", async () => {
    const sessionId = await initSession();

    const delRes = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "DELETE",
      headers: {
        authorization: `Bearer ${suite.http.apiKey}`,
        "mcp-session-id": sessionId,
      },
    });
    expect(delRes.status).toBe(200);
    await delRes.text();

    const followRes = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${suite.http.apiKey}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    await followRes.text();
    expect(followRes.status).toBe(404);
  });

  test("PUT /mcp returns 405 Method Not Allowed", async () => {
    const res = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${suite.http.apiKey}`,
        "content-type": "application/json",
      },
      body: "{}",
    });
    await res.text();
    expect(res.status).toBe(405);
  });

  test("POST JSON-RPC notification (no id) returns 202 Accepted", async () => {
    const sessionId = await initSession();
    const res = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${suite.http.apiKey}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    await res.text();
    expect(res.status).toBe(202);
  });

  test("POST with Accept: application/json only (no text/event-stream) returns 406", async () => {
    const res = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${suite.http.apiKey}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: initializeBody(),
    });
    await res.text();
    expect(res.status).toBe(406);
  });

  test("POST with non-JSON Content-Type returns 415 Unsupported Media Type", async () => {
    const res = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${suite.http.apiKey}`,
        accept: "application/json, text/event-stream",
        "content-type": "text/plain",
      },
      body: initializeBody(),
    });
    await res.text();
    expect(res.status).toBe(415);
  });

  test("GET /mcp with Accept: text/event-stream returns 200 after initialization", async () => {
    const sessionId = await initSession();
    const controller = new AbortController();

    const res = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${suite.http.apiKey}`,
        accept: "text/event-stream",
        "mcp-session-id": sessionId,
      },
      signal: controller.signal,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");

    controller.abort();
    await res.body?.cancel().catch(() => {});
  });

  test("guard accepts older protocol version header 2024-11-05", async () => {
    const res = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${suite.http.apiKey}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-protocol-version": "2024-11-05",
      },
      body: initializeBody(),
    });
    await res.text();
    expect(res.status).toBe(200);
  });

  test("subsequent POST without Mcp-Protocol-Version header succeeds", async () => {
    const sessionId = await initSession();
    const res = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${suite.http.apiKey}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
    });
    await res.text();
    expect(res.status).toBe(200);
  });

  test("D4: SSE response from initialize does not include a retry: field", async () => {
    const res = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${suite.http.apiKey}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: initializeBody(99),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const hasRetry = text.split("\n").some((line) => line.startsWith("retry:"));
    expect(hasRetry).toBe(false);
  });

  test("D5: SSE stream from initialize contains exactly one event carrying the result (no priming event)", async () => {
    const res = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${suite.http.apiKey}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: initializeBody(100),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    const sseEvents = text.split(/\n{2,}/).filter((e) => e.trim() !== "");
    expect(sseEvents.length).toBe(1);
    expect(sseEvents[0]).toContain("data:");
  });
});

describe("guards: pure helpers", () => {
  test("originOf returns null for null, undefined, and empty string", () => {
    expect(guardsTest.originOf(null)).toBeNull();
    expect(guardsTest.originOf(undefined)).toBeNull();
    expect(guardsTest.originOf("")).toBeNull();
  });

  test("originOf extracts the scheme+host+port from a full URL", () => {
    expect(guardsTest.originOf("https://example.com/path?q=1")).toBe("https://example.com");
    expect(guardsTest.originOf("http://localhost:3000/mcp")).toBe("http://localhost:3000");
    expect(guardsTest.originOf("https://api.example.com/health")).toBe("https://api.example.com");
  });

  test("originOf returns null for non-URL strings", () => {
    expect(guardsTest.originOf("not-a-url")).toBeNull();
    expect(guardsTest.originOf("evil.example.com")).toBeNull();
    expect(guardsTest.originOf("//missing-scheme.test")).toBeNull();
  });

  test("allowedOriginsForRequest includes the request URL's own origin", () => {
    const req = new Request("http://127.0.0.1:9876/mcp", { method: "POST" });
    const allowed = guardsTest.allowedOriginsForRequest(req);
    expect(allowed.has("http://127.0.0.1:9876")).toBe(true);
  });

  test("allowedOriginsForRequest does not include arbitrary foreign origins", () => {
    const req = new Request("http://127.0.0.1:9876/mcp", { method: "POST" });
    const allowed = guardsTest.allowedOriginsForRequest(req);
    expect(allowed.has("https://evil.example.test")).toBe(false);
    expect(allowed.has("https://example.com")).toBe(false);
  });
});
