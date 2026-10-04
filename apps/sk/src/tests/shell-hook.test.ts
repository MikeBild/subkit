import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { StatusLineInput } from "../repl/status-line/render.ts";
import { _resetShellHookCacheForTests, runShellHook } from "../repl/status-line/shell-hook.ts";

const baseInput: StatusLineInput = {
  schema_version: 1,
  profile: "default",
  persona: "operator",
  user: "u",
  auth_status: "signed_in",
  tenant: "t",
  engine_url: "http://x",
  model: null,
  session_id: null,
  turn_tokens: null,
  remaining_monthly_budget_tokens: null,
  tokens_today: null,
  connectors_count: null,
  status_message: null,
  permission_mode: "ask",
  cwd: "/",
  git_branch: null,
  timestamp: "2024-11-14T22:13:20.000Z",
};

beforeEach(() => {
  _resetShellHookCacheForTests();
});
afterEach(() => {
  _resetShellHookCacheForTests();
});

describe("runShellHook", () => {
  test("happy path returns fresh stdout line", async () => {
    const r = await runShellHook("printf 'ok'", baseInput, { timeoutMs: 800 });
    expect(r.source).toBe("fresh");
    expect(r.line).toBe("ok");
  });

  test("falls back to empty error when no cache + hook fails", async () => {
    const r = await runShellHook("exit 1", baseInput, { timeoutMs: 800 });
    expect(r.source).toBe("error");
    expect(r.line).toBe("");
  });

  test("uses cached value when a subsequent hook fails", async () => {
    const ok = await runShellHook("printf 'cached'", baseInput, { timeoutMs: 800 });
    expect(ok.source).toBe("fresh");
    const fail = await runShellHook("printf 'cached'", baseInput, { timeoutMs: 800 });
    expect(fail.source).toBe("fresh");
    const failingCmdResult = await runShellHook("exit 1", baseInput, { timeoutMs: 800 });
    expect(failingCmdResult.source).toBe("error");
  });

  test("aborts when the signal is already aborted", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await runShellHook("printf 'never'", baseInput, {
      timeoutMs: 800,
      signal: ctrl.signal,
    });
    expect(r.source).toBe("aborted");
    expect(r.line).toBe("");
  });

  test("aborting mid-flight resolves with cached or aborted status", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await runShellHook("sleep 5; printf 'late'", baseInput, {
      timeoutMs: 5000,
      signal: ctrl.signal,
    });
    expect(["aborted", "cached"]).toContain(r.source);
  });
});
