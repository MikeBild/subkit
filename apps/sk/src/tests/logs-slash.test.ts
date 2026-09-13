// Verifies the /logs slash command is a pure HTTP call into the
// engine's /v1/diagnostics/errors surface — no spawn, no ssh, no
// doctl, no environment-variable side channels.

import { initialSessionState } from "@cli-core/index.ts";
import { describe, expect, test } from "bun:test";

import type { EngineClient, EngineErrorEntry } from "../engine-client.ts";
import { handleSlash } from "../repl/slash/handler.ts";

interface CallSpy {
  query: { limit?: number; trace_id?: string; since?: string };
}

function mkClient(items: EngineErrorEntry[], spy: CallSpy): EngineClient {
  return {
    tailEngineErrors: async (q: typeof spy.query) => {
      spy.query = q;
      return { items, total_buffered: items.length };
    },
  } as unknown as EngineClient;
}

function mkCtx(client: EngineClient) {
  return {
    client,
    profile: {
      name: "test",
      engine_url: "http://x",
      api_key: "k",
      active_tenant_id: null,
    },
    session: initialSessionState(null),
    setConversationId: () => {},
    allowedPermissions: [] as readonly string[],
  };
}

const sampleEntry = (overrides: Partial<EngineErrorEntry> = {}): EngineErrorEntry => ({
  trace_id: "5cdf445aed8d",
  ts: "2026-04-19T07:00:00.000Z",
  tenant_id: "t1",
  method: "POST",
  path: "/v1/conversations",
  status: 500,
  code: "internal_error",
  message: "boom",
  stack: "Error: boom\n  at handler (/x.ts:1:1)\n  at next (/y.ts:2:2)\n  at runtime (/z.ts:3:3)",
  bucket: "unhandled",
  ...overrides,
});

describe("/logs slash", () => {
  test("calls EngineClient.tailEngineErrors with the default limit", async () => {
    const spy: CallSpy = { query: {} };
    const client = mkClient([sampleEntry()], spy);
    const result = await handleSlash("logs", [], mkCtx(client));
    expect(spy.query.limit).toBe(20);
    expect(spy.query.trace_id).toBeUndefined();
    expect(result).toContain("internal_error");
    expect(result).toContain("5cdf445aed8d");
    expect(result).toContain("POST /v1/conversations");
  });

  test("forwards limit + trace_id args to the HTTP query", async () => {
    const spy: CallSpy = { query: {} };
    const client = mkClient([sampleEntry({ trace_id: "abc" })], spy);
    await handleSlash("logs", ["50", "abc"], mkCtx(client));
    expect(spy.query.limit).toBe(50);
    expect(spy.query.trace_id).toBe("abc");
  });

  test("clamps the limit to [1, 200]", async () => {
    const spy: CallSpy = { query: {} };
    const client = mkClient([], spy);
    await handleSlash("logs", ["9999"], mkCtx(client));
    expect(spy.query.limit).toBe(200);
    await handleSlash("logs", ["0"], mkCtx(client));
    expect(spy.query.limit).toBe(20); // 0 → falsy fallback to default
    await handleSlash("logs", ["nope"], mkCtx(client));
    expect(spy.query.limit).toBe(20); // NaN → fallback
  });

  test("renders the empty-buffer message when no items", async () => {
    const spy: CallSpy = { query: {} };
    const client = mkClient([], spy);
    const result = await handleSlash("logs", [], mkCtx(client));
    expect(result).toContain("no captured errors yet");
  });

  test("trace_id query renders trace-specific empty message", async () => {
    const spy: CallSpy = { query: {} };
    const client = mkClient([], spy);
    const result = await handleSlash("logs", ["20", "missing-id"], mkCtx(client));
    expect(result).toContain("no errors matching trace_id missing-id");
  });
});
