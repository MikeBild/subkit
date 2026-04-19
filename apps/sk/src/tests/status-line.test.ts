// Unit tests for apps/sk/src/status-line.ts — the scriptable
// status-line pipeline ported from Claude Code.

import { describe, expect, test } from "bun:test";
import {
  buildStatusLine,
  renderTemplate,
  resolveRefreshMs,
  runStatusLineHook,
  type StatusLineInput,
} from "../status-line.ts";

const INPUT: StatusLineInput = {
  schema_version: 1,
  profile: "default",
  persona: "member",
  user: "mike@mikebild.com",
  auth_status: "signed_in",
  tenant: "t-1",
  engine_url: "http://localhost:8080",
  model: "claude-sonnet-4-6",
  session_id: "abcdef01-1111-1111-1111-111111111111",
  turn_tokens: 42,
  remaining_monthly_budget_tokens: 9958,
  tokens_today: 128,
  connectors_count: 7,
  status_message: null,
  permission_mode: "ask",
  cwd: "/Users/me/work/project",
  git_branch: "main",
  timestamp: "2026-04-15T12:00:00.000Z",
};

describe("sk status line", () => {
  test("renderTemplate expands known placeholders and drops unknowns", () => {
    const out = renderTemplate(
      "{user}{@tenant} · {model} · {turn_tokens}t / {remaining_tokens} · {unknown}",
      INPUT,
    );
    expect(out).toBe("mike@mikebild.com@t-1 · claude-sonnet-4-6 · 42t / 9958");
  });

  test("renderTemplate collapses empty values and their surrounding separators", () => {
    const sparse: StatusLineInput = {
      ...INPUT,
      user: null,
      tenant: null,
      model: null,
      session_id: null,
      turn_tokens: null,
      tokens_today: null,
      connectors_count: null,
      remaining_monthly_budget_tokens: null,
    };
    const out = renderTemplate(
      "{user}{@tenant} · {model} · {turn_tokens}t (today {tokens_today}t) · [{permission_mode}]",
      sparse,
    );
    // No `—` filler; empty fields collapse along with the adjacent ` · ` pair.
    expect(out).toBe("0t (today 0t) · [ask]");
  });

  test("renderTemplate renders engine_host as hostname[:port]", () => {
    const out = renderTemplate("{engine_host}", INPUT);
    expect(out).toBe("localhost:8080");
  });

  test("renderTemplate shortens session_id to 8 chars", () => {
    const out = renderTemplate("sess={session_id}", INPUT);
    expect(out).toBe("sess=abcdef01");
  });

  test("renderTemplate prefixes status_message with separator only when set", () => {
    const withMessage: StatusLineInput = { ...INPUT, status_message: "updating…" };
    expect(renderTemplate("[{permission_mode}]{status_message}", withMessage)).toBe(
      "[ask] · updating…",
    );
    expect(renderTemplate("[{permission_mode}]{status_message}", INPUT)).toBe("[ask]");
  });

  test("renderTemplate uses cwd basename, not absolute path", () => {
    const out = renderTemplate("cwd={cwd}", INPUT);
    expect(out).toBe("cwd=project");
  });

  test("buildStatusLine falls back to template when no command set", async () => {
    const r = await buildStatusLine(undefined, INPUT);
    expect(r.source).toBe("template");
    expect(r.line).toBe("");
  });

  test("buildStatusLine runs a shell hook and surfaces its stdout", async () => {
    const r = await buildStatusLine({ command: `echo "custom-line-ok"` }, INPUT);
    expect(r.source).toBe("hook");
    expect(r.line).toBe("custom-line-ok");
  });

  test("buildStatusLine falls back with ⚠ prefix when the hook errors", async () => {
    const r = await buildStatusLine({ command: "exit 7" }, INPUT);
    expect(r.source).toBe("fallback");
    expect(r.line.startsWith("⚠ ")).toBe(true);
    expect(r.line).toContain("status line unavailable");
    expect(r.error).toContain("exited 7");
  });

  test("runStatusLineHook timeout surfaces a helpful error", async () => {
    await expect(runStatusLineHook("sleep 5", INPUT, 50)).rejects.toThrow(/timed out/);
  });

  test("resolveRefreshMs returns 500 when unset and honors overrides", () => {
    expect(resolveRefreshMs(undefined)).toBe(500);
    expect(resolveRefreshMs({ refreshMs: 1500 })).toBe(1500);
  });
});
