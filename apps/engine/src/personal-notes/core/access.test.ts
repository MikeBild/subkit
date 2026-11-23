import { describe, expect, test } from "bun:test";
import type { ExecutionAuthSource } from "../../auth/index.ts";
import { mayLearn, type NotePrincipal, noteOwner } from "./access.ts";

const SOURCES: Record<ExecutionAuthSource["kind"], ExecutionAuthSource> = {
  api_key: { kind: "api_key", api_key_id: "k1", credential_version: "1" },
  browser_session: { kind: "browser_session", session_id: "s1" },
  mcp_oauth: { kind: "mcp_oauth", access_token_id: "t1", client_id: "c1" },
  token_exchange: {
    kind: "token_exchange",
    api_key_id: "k1",
    credential_version: "1",
    expires_at: "2026-12-01T00:00:00Z",
  },
  external_bearer: {
    kind: "external_bearer",
    provider_id: "p1",
    identity_id: "i1",
    issued_at: "2026-11-01T00:00:00Z",
    expires_at: "2026-12-01T00:00:00Z",
  },
  task_run: { kind: "task_run", task_id: "t1", task_run_id: "r1", grant_id: null },
  device_runner: { kind: "device_runner", device_id: "d1", installation_id: "i1" },
};

function user(source: ExecutionAuthSource | undefined): NotePrincipal {
  return { kind: "user", id: "u1", ...(source ? { auth_source: source } : {}) };
}

describe("noteOwner", () => {
  test.each([
    ["browser_session", true],
    ["mcp_oauth", true],
    ["task_run", true],
    ["api_key", false],
    ["token_exchange", false],
    ["external_bearer", false],
    ["device_runner", false],
  ] as const)("a person signed in through %s owns notes: %s", (kind, owns) => {
    expect(noteOwner(user(SOURCES[kind]))).toEqual(owns ? { user_id: "u1" } : null);
  });

  test("every auth source of the union is decided", () => {
    const decided = Object.keys(SOURCES).sort();
    expect(decided).toEqual([
      "api_key",
      "browser_session",
      "device_runner",
      "external_bearer",
      "mcp_oauth",
      "task_run",
      "token_exchange",
    ]);
  });

  test("a system account never owns notes, whatever it signed in with", () => {
    for (const source of Object.values(SOURCES)) {
      expect(noteOwner({ kind: "system_account", id: "sa1", auth_source: source })).toBeNull();
    }
  });

  test("a person without a known auth source owns nothing", () => {
    expect(noteOwner(user(undefined))).toBeNull();
    expect(noteOwner(null)).toBeNull();
    expect(noteOwner(undefined)).toBeNull();
  });

  test("an exchanged token owns nothing even when it names a session", () => {
    expect(noteOwner({ ...user(SOURCES.browser_session), via: "token_exchange" })).toBeNull();
  });
});

describe("mayLearn", () => {
  test("a task run reads its person's notes and never learns", () => {
    expect(noteOwner(user(SOURCES.task_run))).toEqual({ user_id: "u1" });
    expect(mayLearn(user(SOURCES.task_run))).toBe(false);
  });

  test("a browser session and an MCP sign-in learn", () => {
    expect(mayLearn(user(SOURCES.browser_session))).toBe(true);
    expect(mayLearn(user(SOURCES.mcp_oauth))).toBe(true);
  });

  test("whoever owns nothing learns nothing", () => {
    expect(mayLearn(user(SOURCES.api_key))).toBe(false);
    expect(mayLearn(null)).toBe(false);
  });
});
