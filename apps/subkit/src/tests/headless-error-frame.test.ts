import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs, { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type OutputFormat, runHeadless } from "../headless.ts";

let tmpDir: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "subkit-headless-error-frame-"));
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
});

const TIMEOUT_FRAME = {
  code: "llm_timeout",
  message: "Timed out after 120 s",
  details: { phase: "first_chunk", timeout_ms: 120_000 },
};

function timedOutTurnResponse(): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `event: conversation_started\ndata: ${JSON.stringify({
              conversation: { id: "conv-timeout", title: null, model: null },
            })}\n\n`,
          ),
        );
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${JSON.stringify(TIMEOUT_FRAME)}\n\n`),
        );
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

async function runHeadlessTurn(output: OutputFormat, turnResponse = timedOutTurnResponse) {
  globalThis.fetch = (async (_input: string | URL | Request) =>
    turnResponse()) as typeof globalThis.fetch;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const result = await runHeadless({
    profile: {
      name: "default",
      engine_url: "http://engine.local",
      api_key: "test-key",
      active_tenant_id: "tenant-1",
    },
    prompt: "summarize the quarter",
    output,
    cwd: tmpDir,
    noMemory: true,
    quiet: true,
    stdout: { write: (s) => void stdout.push(s) },
    stderr: { write: (s) => void stderr.push(s) },
  });
  return { result, stdout: stdout.join(""), stderr: stderr.join("") };
}

describe("runHeadless — the engine ends the stream with an error frame", () => {
  test("text mode prints the timeout wording on stderr and exits 1", async () => {
    const { result, stdout, stderr } = await runHeadlessTurn("text");
    expect(result.exitCode).toBe(1);
    expect(stderr).toContain("Timed out after 120 s");
    expect(stderr).toContain("LLM provider timed out");
    expect(stderr).toContain("the model did not answer in time");
    expect(stdout).not.toContain("produced no answer");
  });

  test("json mode reports status error with the frame as a validation error", async () => {
    const { result, stdout } = await runHeadlessTurn("json");
    expect(result.exitCode).toBe(1);
    const payload = JSON.parse(stdout) as {
      status: string;
      validation_errors: Array<{ path: string; message: string }>;
    };
    expect(payload.status).toBe("error");
    expect(payload.validation_errors).toEqual([
      { path: "llm_timeout", message: "Timed out after 120 s" },
    ]);
  });

  test("stream-json mode emits the synthetic validation_error event", async () => {
    const { result, stdout } = await runHeadlessTurn("stream-json");
    expect(result.exitCode).toBe(1);
    const events = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as unknown);
    expect(events).toEqual([
      {
        type: "validation_error",
        errors: [{ path: "llm_timeout", message: "Timed out after 120 s" }],
      },
    ]);
  });
});

test.each(["json", "stream-json"] as const)(
  "headless %s waits for the transport outcome after the model completed event",
  async (output) => {
    let outcomeRead = false;
    let emitted = false;
    const { result, stdout } = await runHeadlessTurn(
      output,
      () =>
        new Response(
          new ReadableStream(
            {
              pull(controller) {
                const encoder = new TextEncoder();
                if (!emitted) {
                  emitted = true;
                  controller.enqueue(
                    encoder.encode(
                      'event: conversation_started\ndata: {"conversation":{"id":"conv-completed"}}\n\nevent: completed\ndata: {"type":"completed","status":"awaiting_input"}\n\n',
                    ),
                  );
                  return;
                }
                outcomeRead = true;
                controller.enqueue(
                  encoder.encode(
                    'event: next_suggestion\ndata: {"type":"next_suggestion","suggestion":"Continue","reason":"suggested","kind":null}\n\nevent: outcome\ndata: {"conversation_id":"conv-completed","status":"awaiting_input"}\n\n',
                  ),
                );
                controller.close();
              },
            },
            { highWaterMark: 0 },
          ),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    expect(result.exitCode).toBe(0);
    expect(outcomeRead).toBe(true);
    if (output === "stream-json") {
      const events = stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { type: string });
      expect(events.at(-1)?.type).toBe("completed");
      expect(events.filter((event) => event.type === "completed")).toHaveLength(1);
    }
  },
);

test("a terminal transport error after model completion remains a failed turn", async () => {
  const { result, stdout } = await runHeadlessTurn(
    "stream-json",
    () =>
      new Response(
        `event: conversation_started\ndata: {"conversation":{"id":"conv-late-error"}}\n\nevent: completed\ndata: {"type":"completed","status":"active"}\n\nevent: error\ndata: ${JSON.stringify(TIMEOUT_FRAME)}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  );
  expect(result.exitCode).toBe(1);
  const events = stdout
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string });
  expect(events.map((event) => event.type)).toEqual(["validation_error"]);
});
