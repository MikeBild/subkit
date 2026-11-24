import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand } from "citty";
import { notificationsCommand } from "../../commands/notifications.ts";

const ENV_KEYS = ["HOME", "SUBKIT_ENGINE_URL", "SUBKIT_API_KEY", "SUBKIT_TENANT", "SUBKIT_PROFILE"];

const INBOX_ITEM = {
  id: 7,
  severity: "info",
  actionable: false,
  event_type: "execution.completed",
  created_at: "2026-11-20T10:00:00.000Z",
};

interface CapturedRequest {
  method: string;
  path: string;
}

let tmpHome: string;
let savedEnv: Record<string, string | undefined>;
let originalFetch: typeof globalThis.fetch;
let originalStdoutWrite: typeof process.stdout.write;
let originalStderrWrite: typeof process.stderr.write;
let capturedStdout: string;
let capturedRequests: CapturedRequest[];

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), "subkit-inbox-json-"));
  savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.HOME = tmpHome;
  process.env.SUBKIT_ENGINE_URL = "http://engine.test";
  process.env.SUBKIT_API_KEY = "wf_live_test_key_xxxxxxxxxxxxxxxxxxxxx";
  delete process.env.SUBKIT_PROFILE;
  capturedRequests = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = input instanceof Request ? input.method : (init?.method ?? "GET");
    capturedRequests.push({ method, path: `${url.pathname}${url.search}` });
    const responseBody = url.pathname.endsWith("/ack")
      ? { acked: 1 }
      : { items: [INBOX_ITEM], cursor: 7 };
    return new Response(JSON.stringify(responseBody), {
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
  rmSync(tmpHome, { recursive: true, force: true });
});

const runNotifications = (rawArgs: string[]) => runCommand(notificationsCommand, { rawArgs });

const parseSingleJsonDocument = (output: string): unknown => JSON.parse(output.trim());

describe("notifications inbox --json emits exactly one JSON document (#513)", () => {
  test("inbox list --json prints a single array", async () => {
    await runNotifications(["inbox", "list", "--json"]);
    expect(parseSingleJsonDocument(capturedStdout)).toEqual([INBOX_ITEM]);
    expect(capturedRequests.filter((request) => request.method === "GET")).toHaveLength(1);
  });

  test("inbox ack --json prints only the ack object", async () => {
    await runNotifications(["inbox", "ack", "--up-to", "7", "--json"]);
    expect(parseSingleJsonDocument(capturedStdout)).toEqual({ acked: 1 });
    expect(capturedRequests.map((request) => request.method)).toEqual(["POST"]);
  });

  test("inbox --json without a subcommand still lists", async () => {
    await runNotifications(["inbox", "--json"]);
    expect(parseSingleJsonDocument(capturedStdout)).toEqual([INBOX_ITEM]);
    expect(capturedRequests).toHaveLength(1);
  });

  test("inbox --json --all passes flags through to the default list", async () => {
    await runNotifications(["inbox", "--json", "--all", "--limit", "5"]);
    expect(parseSingleJsonDocument(capturedStdout)).toEqual([INBOX_ITEM]);
    expect(capturedRequests).toHaveLength(1);
    const [listRequest] = capturedRequests;
    expect(listRequest?.path).toContain("limit=5");
    expect(listRequest?.path).not.toContain("since=");
  });
});
