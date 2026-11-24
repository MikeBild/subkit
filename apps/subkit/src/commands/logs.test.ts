import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runCommand } from "citty";
import { logsCommand } from "./logs.ts";

const TENANT = "10000000-0000-4000-8000-000000000001";

const snapshotEntries = [
  { ts: 1_790_000_000_000, level: "info", module: "scheduler", action: "tick", msg: "tick" },
  {
    ts: 1_790_000_000_500,
    level: "warn",
    module: "migrate",
    action: "drift_detected",
    msg: "drift",
    fields: { table: "workflows", nested: { columns: ["a", "b"] } },
  },
];

const streamedEntries = [
  { ts: 1_790_000_001_000, level: "error", module: "engine", action: "fail", msg: "boom" },
  { ts: 1_790_000_002_000, level: "info", msg: "recovered", fields: { attempt: 2 } },
];

let previousFetch: typeof globalThis.fetch;
let previousWrite: typeof process.stdout.write;
let stdoutChunks: string[];

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

const sseResponse = (entries: readonly unknown[]): Response =>
  new Response(entries.map((entry) => `event: log\ndata: ${JSON.stringify(entry)}\n\n`).join(""), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });

const nonBlankLines = (): string[] =>
  stdoutChunks
    .join("")
    .split("\n")
    .filter((line) => line.trim() !== "");

beforeEach(() => {
  previousFetch = globalThis.fetch;
  previousWrite = process.stdout.write.bind(process.stdout);
  stdoutChunks = [];
  process.env.SUBKIT_ENGINE_URL = "https://engine.test/gateway";
  process.env.SUBKIT_API_KEY = "test-key";
  process.env.SUBKIT_TENANT = TENANT;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/gateway/v1/diagnostics/logs/stream") return sseResponse(streamedEntries);
    if (url.pathname === "/gateway/v1/diagnostics/logs")
      return jsonResponse({ entries: snapshotEntries, next_since_ms: 1_790_000_000_501 });
    return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
  }) as typeof globalThis.fetch;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
});

afterEach(() => {
  globalThis.fetch = previousFetch;
  process.stdout.write = previousWrite;
  delete process.env.SUBKIT_ENGINE_URL;
  delete process.env.SUBKIT_API_KEY;
  delete process.env.SUBKIT_TENANT;
});

describe("subkit logs --json (NDJSON)", () => {
  test("snapshot emits exactly one parseable JSON object per line", async () => {
    await runCommand(logsCommand, { rawArgs: ["--json", "--since", "5m"] });
    const parsedLines = nonBlankLines().map((line) => JSON.parse(line));
    expect(parsedLines).toEqual(snapshotEntries);
  });

  test("--follow emits snapshot and streamed events one JSON object per line", async () => {
    await runCommand(logsCommand, { rawArgs: ["--json", "--follow", "--since", "5m"] });
    const parsedLines = nonBlankLines().map((line) => JSON.parse(line));
    expect(parsedLines).toEqual([...snapshotEntries, ...streamedEntries]);
  });
});
