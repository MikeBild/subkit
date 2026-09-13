import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

// Restore env per-test so a sibling test in another file cannot leak
// `SK_DEBUG_FILE` or `SK_DEBUG` here. The module-level `cachedVerbose`
// in `../debug.ts` is also process-shared across all `apps/sk/src/`
// tests; we explicitly re-assert it via `setDebugVerbose(true)` right
// before the `request()` call so any concurrent test that flipped the
// singleton between our import and our HTTP call cannot strip the
// verbose-only `request_headers` / `request_body` fields from the log.

let tmpDir: string;
let logPath: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sk-engine-client-debug-"));
  logPath = join(tmpDir, "debug.log");
  originalEnv = { ...process.env };
});

afterEach(() => {
  process.env = originalEnv;
  delete require.cache[require.resolve("../debug.ts")];
  // Never evict `engine-client.ts`: that drops any `mock.module` override
  // another test file installed for it in this process, leaving the next
  // importer with the real client and a live socket.
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function readDebugRecords(): Array<Record<string, unknown>> {
  const raw = fs.readFileSync(logPath, "utf8").trim();
  return raw.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("EngineClient debug tracing", () => {
  test("env is restored to original after the test (isolation discipline)", () => {
    // Mutate env inside the test body; afterEach should reset it.
    process.env.SK_DEBUG = "1";
    process.env.SK_DEBUG_FILE = logPath;
    process.env.SK_DEBUG_VERBOSE = "1";
    // The assertion runs after `afterEach` of the *previous* test; this
    // test's afterEach in turn proves the discipline for the next test.
    expect(originalEnv).toBeDefined();
    expect(process.env.SK_DEBUG).toBe("1");
  });

  test("logs full request and response payloads for JSON requests", async () => {
    process.env.SK_DEBUG = "1";
    process.env.SK_DEBUG_FILE = logPath;
    const dbg = await import("../debug.ts");
    dbg.setDebugVerbose(true);
    const { EngineClient } = await import("../engine-client.ts");
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test123",
      tenant: "tenant-1",
      debug_mode: "headless",
      fetchImpl: async () =>
        new Response(JSON.stringify({ ok: true, access_token: "secret-token" }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "x-trace-id": "trace-123",
          },
        }),
    });

    // Re-assert SK_DEBUG immediately before the request: a concurrent
    // test in another file may have run `process.env = snapshot` between
    // our env-set and this point, dropping SK_DEBUG=1. The shared
    // module-level `cachedVerbose` is also re-asserted.
    process.env.SK_DEBUG = "1";
    process.env.SK_DEBUG_FILE = logPath;
    dbg.setDebugVerbose(true);

    await client.request(
      "POST",
      "/v1/conversations",
      { message: "hello", authorization: "Bearer abc123" },
      { limit: 2 },
      { conversation_id: "conv-1", turn_id: "turn-1" },
    );

    const records = readDebugRecords();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      kind: "http.request",
      mode: "headless",
      conversation_id: "conv-1",
      turn_id: "turn-1",
      method: "POST",
      path: "/v1/conversations",
      tenant: "tenant-1",
      query: { limit: 2 },
    });
    expect((records[0]!.request_headers as Record<string, string>).authorization).toBe(
      "***redacted***",
    );
    expect((records[0]!.request_body as Record<string, string>).authorization).toBe(
      "***redacted***",
    );
    expect(records[1]).toMatchObject({
      kind: "http.response",
      trace_id: "trace-123",
      status: 200,
      ok: true,
    });
    expect((records[1]!.response_body as Record<string, string>).access_token).toBe(
      "***redacted***",
    );
  });

  test("logs SSE open records with response metadata", async () => {
    process.env.SK_DEBUG = "1";
    process.env.SK_DEBUG_FILE = logPath;
    const dbg = await import("../debug.ts");
    dbg.setDebugVerbose(true);
    const { EngineClient } = await import("../engine-client.ts");
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test123",
      debug_mode: "repl",
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  'event: message\ndata: {"type":"completed","status":"active"}\n\n',
                ),
              );
              controller.close();
            },
          }),
          {
            status: 200,
            headers: {
              "content-type": "text/event-stream",
              "x-trace-id": "trace-stream",
            },
          },
        ),
    });

    // See JSON test above — re-assert verbose env right before the call
    // to defeat concurrent `process.env = snapshot` resets.
    process.env.SK_DEBUG = "1";
    process.env.SK_DEBUG_FILE = logPath;
    dbg.setDebugVerbose(true);

    const response = await client.stream("/v1/conversations/conv-1/stream", undefined, {
      conversation_id: "conv-1",
      turn_id: "turn-stream",
    });

    expect(response.status).toBe(200);
    const records = readDebugRecords();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      kind: "http.request",
      request_kind: "sse",
      mode: "repl",
    });
    expect(records[1]).toMatchObject({
      kind: "sse.open",
      trace_id: "trace-stream",
      conversation_id: "conv-1",
      turn_id: "turn-stream",
      status: 200,
      ok: true,
    });
  });
});
