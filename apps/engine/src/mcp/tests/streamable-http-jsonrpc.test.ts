import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { type McpTestSuite, startMcpTestSuite } from "./setup.ts";

const MCP_PROTOCOL_VERSION = "2025-11-25";

let suite: McpTestSuite;

beforeAll(async () => {
  suite = await startMcpTestSuite("streamable-http-jsonrpc");
});

afterAll(async () => {
  await suite.cleanup();
});

async function parseMcpBody(res: Response): Promise<unknown> {
  const text = await res.text();
  const trimmed = text.trim();
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    const dataLine = trimmed.split("\n").find((line) => line.startsWith("data:"));
    if (!dataLine) throw new Error(`unexpected SSE payload: ${trimmed}`);
    return JSON.parse(dataLine.slice(5).trim()) as unknown;
  }
  return JSON.parse(trimmed) as unknown;
}

async function parseMcpBodies(res: Response): Promise<unknown[]> {
  const text = await res.text();
  const trimmed = text.trim();
  if (trimmed.startsWith("event:") || trimmed.startsWith("data:")) {
    const dataLines = trimmed.split("\n").filter((line) => line.startsWith("data:"));
    return dataLines.map((line) => JSON.parse(line.slice(5).trim()) as unknown);
  }
  const parsed = JSON.parse(trimmed) as unknown;
  return Array.isArray(parsed) ? parsed : [parsed];
}

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
        clientInfo: { name: "jsonrpc-test", version: "0.0.0" },
      },
    }),
  });
  expect(res.status).toBe(200);
  const sessionId = res.headers.get("mcp-session-id");
  expect(typeof sessionId).toBe("string");
  return sessionId!;
}

async function postSession(
  sessionId: string,
  body: unknown,
): Promise<{ status: number; payload: unknown }> {
  const res = await fetch(`${suite.http.baseUrl}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${suite.http.apiKey}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
  return { status: res.status, payload: await parseMcpBody(res) };
}

function asObject(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`expected JSON-RPC object, got ${JSON.stringify(payload)}`);
  }
  return payload as Record<string, unknown>;
}

function errorOf(payload: unknown): { code?: number; message?: string } {
  return (asObject(payload).error ?? {}) as { code?: number; message?: string };
}

describe("streamable-http JSON-RPC behavior", () => {
  test("invalid JSON returns a parse error envelope", async () => {
    const res = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${suite.http.apiKey}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: "{not-json",
    });

    expect(res.status).toBeGreaterThanOrEqual(400);
    const payload = await parseMcpBody(res);
    expect(asObject(payload).jsonrpc).toBe("2.0");
    expect(errorOf(payload).code).toBe(-32700);
  });

  test("unknown method returns Method not found", async () => {
    const sessionId = await initialize();
    const { status, payload } = await postSession(sessionId, {
      jsonrpc: "2.0",
      id: "unknown-method",
      method: "subkit/doesNotExist",
      params: {},
    });

    expect(status).toBe(200);
    expect(asObject(payload).id).toBe("unknown-method");
    expect(errorOf(payload).code).toBe(-32601);
  });

  test("malformed initialize params return a controlled JSON-RPC error", async () => {
    const res = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${suite.http.apiKey}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "invalid-params",
        method: "initialize",
        params: {},
      }),
    });
    const payload = await parseMcpBody(res);

    expect(res.status).toBe(400);
    expect(asObject(payload).id).toBeNull();
    expect(errorOf(payload).code).toBe(-32000);
  });

  test("ping succeeds on an initialized session", async () => {
    const sessionId = await initialize();
    const { status, payload } = await postSession(sessionId, {
      jsonrpc: "2.0",
      id: "ping",
      method: "ping",
      params: {},
    });

    expect(status).toBe(200);
    expect(asObject(payload).id).toBe("ping");
    expect(asObject(payload).result).toEqual({});
  });

  test("JSON-RPC batch requests return one SSE response per call", async () => {
    const sessionId = await initialize();
    const res = await fetch(`${suite.http.baseUrl}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${suite.http.apiKey}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId,
        "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
      },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: "ping-a", method: "ping", params: {} },
        { jsonrpc: "2.0", id: "ping-b", method: "ping", params: {} },
      ]),
    });
    const payloads = await parseMcpBodies(res);
    const responses = payloads.map(asObject);

    expect(res.status).toBe(200);
    expect(responses.map((item) => item.id)).toEqual(["ping-a", "ping-b"]);
    expect(responses.map((item) => item.result)).toEqual([{}, {}]);
  });
});
