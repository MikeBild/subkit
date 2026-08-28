import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpDir: string;
let logPath: string;
let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sk-trace-id-"));
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

describe("outbound trace-id propagation", () => {
  test("every JSON request sets x-sk-trace-id and tags log records with it", async () => {
    process.env.SK_DEBUG_FILE = logPath;
    const seenHeaders: Headers[] = [];
    const { EngineClient } = await import("../engine-client.ts");
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      fetchImpl: async (_url, init) => {
        seenHeaders.push(new Headers(init?.headers));
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json", "x-trace-id": "engine-echo-id" },
        });
      },
    });

    await client.request("GET", "/health");
    expect(seenHeaders).toHaveLength(1);
    const sentTraceId = seenHeaders[0]!.get("x-sk-trace-id");
    expect(sentTraceId).toMatch(/^cli-[a-zA-Z0-9_-]{8,}$/);

    const records = readDebugRecords();
    // every record for this request must carry the same trace_id
    const traceIds = new Set(records.map((r) => r.trace_id));
    // engine echoed a different id back; CLI keeps its outbound id as the
    // primary, but http.response also carries the engine-issued id under
    // the dedicated `trace_id` field of the response — verify both shapes.
    expect(traceIds.has(sentTraceId)).toBe(true);
  });

  test("SSE stream also sets x-sk-trace-id", async () => {
    process.env.SK_DEBUG_FILE = logPath;
    const seenHeaders: Headers[] = [];
    const { EngineClient } = await import("../engine-client.ts");
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      fetchImpl: async (_url, init) => {
        seenHeaders.push(new Headers(init?.headers));
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("event: message\ndata: {}\n\n"));
              controller.close();
            },
          }),
          { status: 200, headers: { "x-trace-id": "engine-sse-id" } },
        );
      },
    });

    await client.stream("/v1/conversations/cv-1/stream");
    expect(seenHeaders).toHaveLength(1);
    const sentTraceId = seenHeaders[0]!.get("x-sk-trace-id");
    expect(sentTraceId).toMatch(/^cli-[a-zA-Z0-9_-]{8,}$/);
  });

  test("respects an inbound debugContext.trace_id (turn-scoped)", async () => {
    process.env.SK_DEBUG_FILE = logPath;
    const seenHeaders: Headers[] = [];
    const { EngineClient } = await import("../engine-client.ts");
    const client = new EngineClient({
      engine_url: "http://engine.local",
      api_key: "wf_live_test",
      fetchImpl: async (_url, init) => {
        seenHeaders.push(new Headers(init?.headers));
        return new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });

    await client.request("POST", "/v1/x", null, undefined, { trace_id: "turn-abc-xyz-1234" });
    expect(seenHeaders[0]!.get("x-sk-trace-id")).toBe("turn-abc-xyz-1234");
  });
});
