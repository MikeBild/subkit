// Streamable HTTP transport guards and wire-shape pins.
//
// Suite 1 — HTTP transport guards (integration):
//   Origin rejection, same-origin passthrough, protocol-version gate.
//
// Suite 2 — Session lifecycle pins (integration):
//   Missing session id → 400, DELETE → 200 then 404, PUT → 405,
//   notification → 202, Accept negotiation (406/415), GET SSE → 200,
//   older protocol version, absent version header, SSE format (D4/D5).
//
// Suite 3 — guards.ts pure helpers (unit):
//   originOf and allowedOriginsForRequest without the HTTP stack.

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

/** Initialize a session and return its id. Body is drained to prevent leaks. */
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
  await res.text(); // drain
  const sessionId = res.headers.get("mcp-session-id");
  expect(typeof sessionId).toBe("string");
  return sessionId!;
}

// ──────────────────────────────────────────────────────────────────────────
// Suite 1 — Transport guards (pre-existing tests, unchanged)
// ──────────────────────────────────────────────────────────────────────────

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
      'scope="mcp:read mcp:authoring mcp:admin metrics:read"',
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

// ──────────────────────────────────────────────────────────────────────────
// Suite 2 — Session lifecycle and content-negotiation pins (P3)
// ──────────────────────────────────────────────────────────────────────────

describe("streamable-http session lifecycle and wire shape", () => {
  // P3 — Missing session: a POST with a non-initialize method and no
  // Mcp-Session-Id header MUST return 400 because the server has no context
  // for the request (the handshake was never completed on this transport).
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
    // SDK: non-initialize POST with no session → "Server not initialized" → 400.
    expect(res.status).toBe(400);
  });

  // P3 — DELETE: the spec requires DELETE /mcp to terminate the session (200)
  // and a follow-up POST with the same session id to return 404 (stale session).
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

    // The sessions Map has been cleared; the follow-up should get a 404.
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

  // P3 — PUT: the SDK only handles GET, POST, DELETE. Any other method MUST
  // return 405 Method Not Allowed.
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

  // P3 — Notification: a JSON-RPC notification (no id field) MUST receive
  // 202 Accepted — the server has nothing to send back.
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
      // No "id" field → JSON-RPC notification.
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    await res.text();
    expect(res.status).toBe(202);
  });

  // P3 — Accept negotiation: enableJsonResponse is OFF in the subkit engine.
  // A POST that only accepts application/json (no text/event-stream) MUST
  // return 406 Not Acceptable because the transport can only emit SSE.
  test("POST with Accept: application/json only (no text/event-stream) returns 406", async () => {
    const res = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${suite.http.apiKey}`,
        accept: "application/json", // text/event-stream is absent
        "content-type": "application/json",
      },
      body: initializeBody(),
    });
    await res.text();
    expect(res.status).toBe(406);
  });

  // P3 — Content-Type gate: the SDK rejects any POST whose Content-Type is
  // not application/json with 415 Unsupported Media Type.
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

  // P3 — GET SSE: a GET /mcp request on an existing session with
  // Accept: text/event-stream MUST return 200 and open an SSE stream.
  // The stream is kept alive for server→client notifications; we abort
  // immediately after confirming the status line and content-type.
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

    // Abort and drain — the stream is persistent; we don't need more data.
    controller.abort();
    await res.body?.cancel().catch(() => {});
  });

  // P3 — Older protocol version: 2024-11-05 is in SUPPORTED_PROTOCOL_VERSIONS
  // and MUST pass the guard. The server processes the initialize normally.
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
    // Guard passes: no 400 "Unsupported protocol version".
    expect(res.status).toBe(200);
  });

  // P3 — Absent version header: the guard only rejects when the header IS
  // present but unsupported. Omitting it entirely MUST succeed.
  test("subsequent POST without Mcp-Protocol-Version header succeeds", async () => {
    const sessionId = await initSession();
    const res = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${suite.http.apiKey}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        "mcp-session-id": sessionId,
        // No Mcp-Protocol-Version header — guard must pass.
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: {} }),
    });
    await res.text();
    expect(res.status).toBe(200);
  });

  // D4 — No retry: field: the SSE stream from an initialize response MUST NOT
  // include a `retry:` directive. subkit's engine does not configure a
  // retryInterval on the transport so no retry: field should appear.
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

  // D5 — No priming event: when no eventStore is configured the transport
  // MUST NOT emit a priming SSE event (a separate blank-line-delimited event)
  // before the initialize result. The standard SSE `event: message` field is
  // the type annotation for the initialize event itself — it is NOT a priming
  // event. There should be exactly one SSE event in the response body and it
  // must carry `data:` with the JSON-RPC result.
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
    // SSE events are separated by one or more blank lines.
    const sseEvents = text.split(/\n{2,}/).filter((e) => e.trim() !== "");
    // Without an eventStore there is no priming event: exactly one event is emitted.
    expect(sseEvents.length).toBe(1);
    // That single event must carry the initialize result in a data: line.
    expect(sseEvents[0]).toContain("data:");
  });
});

// ──────────────────────────────────────────────────────────────────────────
// Suite 3 — guards.ts pure helpers (unit — no DB or server calls)
// ──────────────────────────────────────────────────────────────────────────

describe("guards: pure helpers", () => {
  test("originOf returns null for null, undefined, and empty string", () => {
    expect(guardsTest.originOf(null)).toBeNull();
    expect(guardsTest.originOf(undefined)).toBeNull();
    expect(guardsTest.originOf("")).toBeNull();
  });

  test("originOf extracts the scheme+host+port from a full URL", () => {
    expect(guardsTest.originOf("https://example.com/path?q=1")).toBe("https://example.com");
    expect(guardsTest.originOf("http://localhost:3000/mcp")).toBe("http://localhost:3000");
    expect(guardsTest.originOf("https://api.subkit.io/health")).toBe("https://api.subkit.io");
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
