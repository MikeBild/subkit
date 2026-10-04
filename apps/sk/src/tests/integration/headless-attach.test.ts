import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runHeadless } from "../../headless.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const CONV_ID = "conv-00000000-0000-0000-0000-aabbccddee01";
const FID = "fid_00000000-0000-0000-0000-000000000020";
const FILENAME = "report.txt";

const encoder = new TextEncoder();

function sseFrame(data: unknown): Uint8Array {
  return encoder.encode(`event: message\ndata: ${JSON.stringify(data)}\n\n`);
}

function makeConvResponse() {
  return new Response(
    JSON.stringify({
      conversation: {
        id: CONV_ID,
        tenant_id: "t-test",
        target_workflow_id: null,
        target_connector_id: null,
        status: "active",
        owner_id: null,
        model: null,
        title: null,
        created_at: NOW,
        updated_at: NOW,
      },
      events: [],
      status: "active",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function makeFileRow() {
  return {
    id: FID,
    status: "ready",
    filename: FILENAME,
    content_type: "text/plain",
    size_bytes: 4,
    sha256: "ff00",
    scan_result: null,
    created_at: NOW,
    updated_at: NOW,
    deleted_at: null,
  };
}

function makeStreamResponse(text: string) {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(sseFrame({ type: "message", role: "assistant", content: { text } }));
        controller.enqueue(sseFrame({ type: "completed", status: "completed", usage: null }));
        controller.close();
      },
    }),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

const PROFILE = {
  name: "default",
  engine_url: "http://engine.local",
  api_key: "wf_live_test",
  active_tenant_id: "t-test",
};

let tmpDir: string;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "sk-headless-attach-"));
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("runHeadless --attach", () => {
  test("happy path stream-json emits file_attached then assistant event", async () => {
    const fp = join(tmpDir, FILENAME);
    writeFileSync(fp, "data");

    let fetchCount = 0;
    globalThis.fetch = (async (_input, _init) => {
      fetchCount++;
      const url = String(_input);

      if (fetchCount === 1) return makeConvResponse();
      if (url.includes("/v1/files/inline"))
        return new Response(JSON.stringify(makeFileRow()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/links"))
        return new Response(
          JSON.stringify({
            id: "link-1",
            file_id: FID,
            resource_type: "conversation",
            resource_id: CONV_ID,
            slug: null,
            role: "attachment",
            created_at: NOW,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      if (url.includes("/messages")) return makeStreamResponse("File received!");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;

    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runHeadless({
      profile: PROFILE,
      prompt: "summarize the file",
      output: "stream-json",
      cwd: tmpDir,
      noMemory: true,
      attach: [fp],
      stdout: { write: (s) => void stdout.push(s) },
      stderr: { write: (s) => void stderr.push(s) },
    });

    expect(result.exitCode).toBe(0);

    const allOut = stdout.join("");
    const lines = allOut
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);

    const fileAttached = lines.find((l) => "file_attached" in l);
    expect(fileAttached).toBeDefined();
    expect(fileAttached?.file_attached).toBe(FID);
    expect(fileAttached?.filename).toBe(FILENAME);
  });

  test("unreadable path → exitCode 1, stream-json ATTACH_FAILED", async () => {
    const missingPath = join(tmpDir, "no-such-file.pdf");

    globalThis.fetch = (async () => makeConvResponse()) as unknown as typeof globalThis.fetch;

    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runHeadless({
      profile: PROFILE,
      prompt: "does not matter",
      output: "stream-json",
      cwd: tmpDir,
      noMemory: true,
      attach: [missingPath],
      stdout: { write: (s) => void stdout.push(s) },
      stderr: { write: (s) => void stderr.push(s) },
    });

    expect(result.exitCode).toBe(1);
    const allOut = stdout.join("");
    const lines = allOut
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const errorLine = lines.find((l) => l.error === "ATTACH_FAILED");
    expect(errorLine).toBeDefined();
  });

  test("text mode: attach succeeds silently, assistant text on stdout", async () => {
    const fp = join(tmpDir, "silent.txt");
    writeFileSync(fp, "shhh");

    let fetchCount = 0;
    globalThis.fetch = (async (_input) => {
      fetchCount++;
      const url = String(_input);
      if (fetchCount === 1) return makeConvResponse();
      if (url.includes("/v1/files/inline"))
        return new Response(JSON.stringify(makeFileRow()), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (url.includes("/links"))
        return new Response(
          JSON.stringify({
            id: "lk",
            file_id: FID,
            resource_type: "conversation",
            resource_id: CONV_ID,
            slug: null,
            role: "attachment",
            created_at: NOW,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      if (url.includes("/messages")) return makeStreamResponse("Quiet success!");
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;

    const stdout: string[] = [];
    const stderr: string[] = [];
    const result = await runHeadless({
      profile: PROFILE,
      prompt: "go",
      output: "text",
      cwd: tmpDir,
      noMemory: true,
      attach: [fp],
      stdout: { write: (s) => void stdout.push(s) },
      stderr: { write: (s) => void stderr.push(s) },
    });

    expect(result.exitCode).toBe(0);
    expect(stdout.join("")).toContain("Quiet success!");
    expect(stdout.join("")).not.toContain("file_attached");
  });
});
