import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentBrowserProcessOptions,
  callArguments,
  createAgentBrowserProcess,
  parseCallOutput,
} from "./agent-browser.ts";

const FIXTURE = join(import.meta.dir, "agent-browser.fixture.ts");
const work = mkdtempSync(join(tmpdir(), "subkit-ab-"));

afterAll(() => rmSync(work, { recursive: true, force: true }));

function processClient(overrides: Partial<AgentBrowserProcessOptions> = {}) {
  return createAgentBrowserProcess({
    command: [process.execPath, FIXTURE],
    env: { PATH: process.env.PATH ?? "", AGENT_BROWSER_SESSION: "subkit-default", HOME: work },
    cwd: work,
    version: "0.43.0",
    timeoutMs: 20_000,
    ...overrides,
  });
}

const live = () => new AbortController().signal;

function appears(path: string): Promise<void> {
  return new Promise((resolve) => {
    if (existsSync(path)) return resolve();
    const watcher = watch(work, () => {
      if (!existsSync(path)) return;
      watcher.close();
      resolve();
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("call output parsing", () => {
  const meta = { _meta: { agentBrowserVersion: "0.43.0" } };

  test("a successful response returns its data", () => {
    const line = JSON.stringify({
      ...meta,
      isError: false,
      structuredContent: { response: { success: true, data: { url: "https://x/" } } },
    });
    expect(parseCallOutput(`noise\n${line}\n`, "0.43.0")).toEqual({
      ok: true,
      data: { url: "https://x/" },
    });
    const empty = JSON.stringify({
      ...meta,
      structuredContent: { response: { success: true } },
    });
    expect(parseCallOutput(empty, "0.43.0")).toEqual({ ok: true, data: null });
  });

  test("another version, a call error, a failed action and garbage never pass", () => {
    const other = JSON.stringify({ _meta: { agentBrowserVersion: "0.44.0" } });
    expect(parseCallOutput(other, "0.43.0")).toMatchObject({ ok: false, code: "browser_version" });
    expect(parseCallOutput(JSON.stringify({}), "0.43.0")).toMatchObject({
      ok: false,
      code: "browser_version",
    });
    const refused = JSON.stringify({ ...meta, error: { message: "unknown tool" } });
    expect(parseCallOutput(refused, "0.43.0")).toEqual({
      ok: false,
      code: "browser_call",
      error: "unknown tool",
    });
    const failed = JSON.stringify({
      ...meta,
      isError: true,
      structuredContent: { response: { success: false, error: "gone", code: "tab_gone" } },
    });
    expect(parseCallOutput(failed, "0.43.0")).toEqual({
      ok: false,
      code: "tab_gone",
      error: "gone",
    });
    const noResponse = JSON.stringify({ ...meta, structuredContent: {} });
    expect(parseCallOutput(noResponse, "0.43.0")).toMatchObject({
      ok: false,
      code: "browser_action",
    });
    expect(parseCallOutput("not json", "0.43.0")).toMatchObject({
      ok: false,
      code: "browser_unreadable",
    });
    expect(parseCallOutput(JSON.stringify({ _meta: 5 }), "0.43.0")).toMatchObject({
      ok: false,
      code: "browser_unreadable",
    });
  });

  test("arguments travel as one JSON value, never as flags", () => {
    expect(callArguments("agent_browser_fill", { selector: "@e1", text: "--proxy x" })).toEqual([
      "mcp",
      "call",
      "agent_browser_fill",
      '{"selector":"@e1","text":"--proxy x"}',
      "--tools",
      "all",
    ]);
  });
});

describe("agent-browser process", () => {
  test("runs one tool call in the SubKit environment", async () => {
    const client = processClient();
    const result = await client.call("agent_browser_env", { text: "--session other" }, live());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const data = result.data as { env: Record<string, string>; cwd: string; args: unknown };
    expect(data.env).toEqual({ AGENT_BROWSER_SESSION: "subkit-default", HOME: work });
    expect(data.args).toEqual({ text: "--session other" });
  });

  test("reports failures, version drift and unreadable answers", async () => {
    expect(await processClient().call("agent_browser_fail", {}, live())).toEqual({
      ok: false,
      code: "not_found",
      error: "Element @e9 not found",
    });
    expect(await processClient().call("agent_browser_garbage", {}, live())).toMatchObject({
      ok: false,
      code: "browser_unreadable",
    });
    const drift = processClient({
      env: { PATH: process.env.PATH ?? "", FAKE_AGENT_BROWSER_VERSION: "0.44.1" },
    });
    expect(await drift.call("agent_browser_get_url", {}, live())).toMatchObject({
      ok: false,
      code: "browser_version",
    });
    const missing = processClient({ command: [join(work, "missing-binary")] });
    expect(await missing.call("agent_browser_get_url", {}, live())).toMatchObject({
      ok: false,
      code: "browser_missing",
    });
    expect(
      await processClient().call("agent_browser_huge", { bytes: 49 * 1024 * 1024 }, live()),
    ).toMatchObject({ ok: false, code: "too_large" });
  });

  test("a stop kills the running call well within one second", async () => {
    const marker = join(work, "wait.pid");
    const client = processClient({
      env: { PATH: process.env.PATH ?? "", FAKE_AGENT_BROWSER_PID_FILE: marker },
    });
    const controller = new AbortController();
    const pending = client.call("agent_browser_wait_ms", { ms: 20_000 }, controller.signal);
    await appears(marker);
    const pid = Number(readFileSync(marker, "utf8"));
    const started = performance.now();
    controller.abort();
    expect(await pending).toEqual({ ok: false, code: "stopped", error: "Stopped." });
    expect(performance.now() - started).toBeLessThan(1000);
    const gone = new Promise<void>((resolve) => {
      const check = () => (alive(pid) ? setImmediate(check) : resolve());
      check();
    });
    await gone;
    expect(alive(pid)).toBe(false);
  });

  test("an aborted signal never spawns, a slow call times out", async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await processClient().call("agent_browser_get_url", {}, controller.signal)).toEqual({
      ok: false,
      code: "stopped",
      error: "Stopped.",
    });
    const slow = processClient({ timeoutMs: 50 });
    expect(await slow.call("agent_browser_wait_ms", { ms: 20_000 }, live())).toMatchObject({
      ok: false,
      code: "browser_timeout",
    });
  });
});
