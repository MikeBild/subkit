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
  } catch {}
});

function readDebugKinds(): string[] {
  const raw = fs.readFileSync(logPath, "utf8").trim();
  return raw
    .split("\n")
    .map((line) => JSON.parse(line) as { kind: string })
    .map((record) => record.kind);
}

function sseResponse(text = "ok"): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: message\ndata: {"type":"message","role":"assistant","content":{"text":"${text}"}}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode('event: message\ndata: {"type":"completed","status":"active"}\n\n'),
        );
        controller.enqueue(encoder.encode('event: outcome\ndata: {"status":"completed"}\n\n'));
        controller.close();
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-trace-id": "trace-stream" },
    },
  );
}

function createSseResponse(text = "ok"): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: conversation_started\ndata: ${JSON.stringify({
              conversation: {
                id: "conv-1",
                title: null,
                model: null,
              },
            })}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(
            `event: message\ndata: {"type":"message","role":"assistant","content":{"text":"${text}"}}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode('event: message\ndata: {"type":"completed","status":"active"}\n\n'),
        );
        controller.enqueue(encoder.encode('event: outcome\ndata: {"status":"completed"}\n\n'));
      },
    }),
    {
      status: 200,
      headers: { "content-type": "text/event-stream", "x-trace-id": "trace-stream" },
    },
  );
}

function readJsonBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== "string") return {};
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe("runHeadless debug tracing", () => {
  test("logs turn lifecycle and streamed frames", async () => {
    process.env.SK_DEBUG = "1";
    process.env.SK_DEBUG_FILE = logPath;
    let fetchCount = 0;
    globalThis.fetch = (async (input) => {
      fetchCount += 1;
      const url = String(input);
      if (fetchCount === 1) {
        expect(url).toContain("/v1/conversations");
        return createSseResponse("Hello, world!");
      }
      return sseResponse("unexpected request");
    }) as typeof globalThis.fetch;

    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runHeadless({
      profile: {
        name: "default",
        engine_url: "http://engine.local",
        api_key: "test-key",
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

  test("resume hydrates history and consumes the append stream without replaying SSE", async () => {
    const encoder = new TextEncoder();
    const urls: string[] = [];
    let cancelled = false;
    globalThis.fetch = (async (input, init) => {
      urls.push(String(input));
      if (init?.method === "GET") {
        return new Response(
          JSON.stringify({
            conversation: {},
            messages: [
              {
                id: "msg-user-1",
                role: "user",
                parts: [{ type: "text", text: "first" }],
                created_at: "2026-01-01T00:00:00.000Z",
              },
              {
                id: "msg-assistant-1",
                role: "assistant",
                parts: [{ type: "text", text: "remembered" }],
                created_at: "2026-01-01T00:00:01.000Z",
              },
            ],
            tool_calls: [],
            draft: null,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      expect(init?.method).toBe("POST");
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              encoder.encode(
                'event: message\ndata: {"type":"message","role":"assistant","content":{"text":"resumed"}}\n\n',
              ),
            );
            controller.enqueue(
              encoder.encode('event: message\ndata: {"type":"completed","status":"active"}\n\n'),
            );
            controller.enqueue(encoder.encode('event: outcome\ndata: {"status":"completed"}\n\n'));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof globalThis.fetch;

    const stdout: string[] = [];
    const result = await runHeadless({
      profile: {
        name: "default",
        engine_url: "http://engine.local",
        api_key: "test-key",
        active_tenant_id: "tenant-1",
      },
      prompt: "continue",
      output: "json",
      resume: "conv-existing",
      cwd: tmpDir,
      noMemory: true,
      stdout: { write: (s) => void stdout.push(s) },
      stderr: { write: () => undefined },
    });

    expect(result.exitCode).toBe(0);
    expect(urls).toEqual([
      "http://engine.local/v1/conversations/conv-existing",
      "http://engine.local/v1/conversations/conv-existing/messages",
    ]);
    expect(urls.some((url) => url.endsWith("/stream"))).toBe(false);
    expect(stdout.join("")).toContain('"session_id": "conv-existing"');
    expect(stdout.join("")).toContain('"content": "remembered"');
    expect(cancelled).toBe(true);
  });

  test("resolves connector slug bindings before creating a conversation", async () => {
    const connectorId = "11111111-1111-4111-8111-111111111111";
    let createdConnectorId: unknown = null;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/v1/connectors")) {
        return new Response(
          JSON.stringify({
            items: [{ id: connectorId, slug: "open-meteo-weather", name: "Open-Meteo Weather" }],
            total: 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/v1/conversations") && init?.method === "POST") {
        createdConnectorId = readJsonBody(init).connector_id;
        return createSseResponse();
      }
      return sseResponse();
    }) as typeof globalThis.fetch;

    const result = await runHeadless({
      profile: {
        name: "default",
        engine_url: "http://engine.local",
        api_key: "test-key",
        active_tenant_id: "tenant-1",
      },
      prompt: "use weather",
      output: "text",
      cwd: tmpDir,
      noMemory: true,
      connector_id: "open-meteo-weather",
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    });

    expect(result.exitCode).toBe(0);
    expect(createdConnectorId).toBe(connectorId);
  });

  test("resolves workflow slug bindings before creating a conversation", async () => {
    const workflowId = "22222222-2222-4222-8222-222222222222";
    let createdWorkflowId: unknown = null;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.includes("/v1/workflows")) {
        return new Response(
          JSON.stringify({
            items: [
              { id: workflowId, slug: "berlin-weather-tomorrow", name: "Berlin Weather Tomorrow" },
            ],
            total: 1,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/v1/conversations") && init?.method === "POST") {
        createdWorkflowId = readJsonBody(init).workflow_id;
        return createSseResponse();
      }
      return sseResponse();
    }) as typeof globalThis.fetch;

    const result = await runHeadless({
      profile: {
        name: "default",
        engine_url: "http://engine.local",
        api_key: "wf_live_test123",
        active_tenant_id: "tenant-1",
      },
      prompt: "run weather",
      output: "text",
      cwd: tmpDir,
      noMemory: true,
      workflow_id: "berlin-weather-tomorrow",
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    });

    expect(result.exitCode).toBe(0);
    expect(createdWorkflowId).toBe(workflowId);
  });
});
