import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runCommand } from "citty";
import { schedulesCommand } from "../../commands/schedules.ts";

const ENV_KEYS = ["SUBKIT_ENGINE_URL", "SUBKIT_API_KEY", "SUBKIT_TENANT"];

let savedEnv: Record<string, string | undefined>;
let originalFetch: typeof globalThis.fetch;
let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;
let capturedStdout: string;
let requestedPaths: string[];

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.SUBKIT_ENGINE_URL = "http://engine.test";
  process.env.SUBKIT_API_KEY = "wf_live_test_key_xxxxxxxxxxxxxxxxxxxxx";
  requestedPaths = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    requestedPaths.push(`${url.pathname}${url.search}`);
    return new Response(JSON.stringify({ schedules: [], total: 0 }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  capturedStdout = "";
  originalStdoutWrite = process.stdout.write.bind(process.stdout);
  originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    capturedStdout += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("schedules without a subcommand lists via citty default", () => {
  test("bare schedules lists once in human form", async () => {
    await runCommand(schedulesCommand, { rawArgs: [] });
    expect(requestedPaths).toHaveLength(1);
    expect(capturedStdout).toEndWith("0 schedules total\n");
  });

  test("schedules --json --workflow forwards flags and emits one JSON document", async () => {
    await runCommand(schedulesCommand, { rawArgs: ["--json", "--workflow", "wf-1"] });
    expect(requestedPaths).toHaveLength(1);
    expect(requestedPaths[0]).toContain("workflow_id=wf-1");
    expect(JSON.parse(capturedStdout.trim())).toEqual([]);
  });

  test("schedules list --json runs the list exactly once", async () => {
    await runCommand(schedulesCommand, { rawArgs: ["list", "--json"] });
    expect(requestedPaths).toHaveLength(1);
    expect(JSON.parse(capturedStdout.trim())).toEqual([]);
  });
});
