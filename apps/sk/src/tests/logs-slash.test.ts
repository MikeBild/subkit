import { describe, expect, test } from "bun:test";
import { initialSessionState } from "@cli-core/index.ts";
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
    expect(spy.query.limit).toBe(20);
    await handleSlash("logs", ["nope"], mkCtx(client));
    expect(spy.query.limit).toBe(20);
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

describe("/exec step list", () => {
  function stepsClient(items: unknown[]): EngineClient {
    return { executionSteps: async () => ({ items }) } as unknown as EngineClient;
  }

  test("renders step key, kind, status, duration and error message from the contract shape", async () => {
    const client = stepsClient([
      {
        id: "s1",
        step_key: "fetch",
        kind: "http",
        status: "succeeded",
        duration_ms: 42,
        error: null,
      },
      {
        id: "s2",
        step_key: "write",
        kind: "postgres",
        status: "failed",
        duration_ms: null,
        error: { message: "permission denied" },
      },
      { id: "s3", step_key: "", kind: "", status: "", duration_ms: null, error: "plain" },
    ]);
    const result = await handleSlash("exec", ["0123456789abcdef"], mkCtx(client));
    expect(result).toContain("logs · 01234567");
    expect(result).toContain("✓ fetch (http) · succeeded · 42ms");
    expect(result).toContain("✗ write (postgres) · failed · — · permission denied");
    expect(result).toContain("· ? (?) · ? · —");
    expect(result).not.toContain("plain");
  });

  test("renders the empty message when the execution has no steps", async () => {
    const result = await handleSlash("exec", ["0123456789abcdef"], mkCtx(stepsClient([])));
    expect(result).toContain("no steps recorded for this execution");
  });
});
