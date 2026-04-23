import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHeadless } from "../headless.ts";

let tmpDir: string;
let logPath: string;
let originalEnv: NodeJS.ProcessEnv;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sk-headless-debug-"));
  logPath = join(tmpDir, "debug.log");
  originalEnv = { ...process.env };
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  process.env = originalEnv;
  globalThis.fetch = originalFetch;
  delete require.cache[require.resolve("../debug.ts")];
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function readDebugKinds(): string[] {
  const raw = fs.readFileSync(logPath, "utf8").trim();
  return raw
    .split("\n")
    .map((line) => JSON.parse(line) as { kind: string })
    .map((record) => record.kind);
}

describe("runHeadless debug tracing", () => {
  test("logs turn lifecycle and streamed frames", async () => {
    process.env.SK_DEBUG = "1";
    process.env.SK_DEBUG_FILE = logPath;
    const encoder = new TextEncoder();
    let fetchCount = 0;
    globalThis.fetch = (async (input) => {
      fetchCount += 1;
      const url = String(input);
      if (fetchCount === 1) {
        expect(url).toContain("/v1/conversations");
        return new Response(
          JSON.stringify({
            conversation: {
              id: "conv-1",
              tenant_id: "tenant-1",
              target_workflow_id: null,
              target_connector_id: null,
              status: "active",
              owner_id: null,
              model: null,
              title: null,
              created_at: "2026-04-23T00:00:00.000Z",
              updated_at: "2026-04-23T00:00:00.000Z",
            },
            events: [],
            status: "active",
          }),
          {
            status: 200,
            headers: { "content-type": "application/json", "x-trace-id": "trace-create" },
          },
        );
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'event: message\ndata: {"type":"message","role":"assistant","content":{"text":"Hello, world!"}}\n\n',
              ),
            );
            controller.enqueue(
              encoder.encode('event: message\ndata: {"type":"completed","status":"active"}\n\n'),
            );
            controller.close();
          },
        }),
        {
          status: 200,
          headers: { "content-type": "text/event-stream", "x-trace-id": "trace-stream" },
        },
      );
    }) as typeof globalThis.fetch;

    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runHeadless({
      profile: {
        name: "default",
        engine_url: "http://engine.local",
        api_key: "wf_live_test123",
        active_tenant_id: "tenant-1",
      },
      prompt: "say hi",
      output: "text",
      cwd: tmpDir,
      noMemory: true,
      stdout: { write: (s) => void stdout.push(s) },
      stderr: { write: (s) => void stderr.push(s) },
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.join("")).toContain("Hello, world!");
    expect(stderr.join("")).toBe("");
    expect(readDebugKinds()).toEqual(
      expect.arrayContaining([
        "dialog.turn_start",
        "dialog.prompt_resolved",
        "conversation.turn_events",
        "sse.open",
        "sse.frame",
        "dialog.turn_event",
        "sse.close",
        "dialog.render_output",
        "dialog.turn_end",
      ]),
    );
  });
});
