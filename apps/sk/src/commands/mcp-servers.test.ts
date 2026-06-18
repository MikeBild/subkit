// Unit tests for the `sk mcp-servers` command handlers.
//
// Follows the create-json-contract.test.ts pattern:
//   - EngineClient and config (resolveProfile) are stubbed via mock.module()
//   - No network, no engine, no process.exit
//   - stdout/stderr are captured per-test via write overrides
//   - mock.module originals restored in afterAll to prevent worker-level leakage
//
// Coverage:
//   - add --json: stdout is valid JSON; stderr is empty; auth_config.kind preserved
//   - list --json: stdout is a JSON array; each item has id, name, namespace, status
//   - get --json: stdout is a valid JSON object with id field
//   - disable --json: stdout JSON carries status === "disabled"
//   - enable --json: stdout JSON carries status === "active"
//   - network error → --json emits { error: "..." } to stdout; stderr stays empty
//   - remove --yes: stdout writes "deleted\n"

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Capture original module shapes BEFORE mocking to restore in afterAll.
const realEngineClient = await import("../engine-client.ts");
const realConfig = await import("../config.ts");

const ORIGINAL_ENGINE_CLIENT = { ...realEngineClient };
const ORIGINAL_CONFIG = { ...realConfig };

// ── Stub EngineClient ─────────────────────────────────────────────────────────

const STUB_SERVER = {
  id: "srv-00000001-0000-4000-8000-000000000001",
  name: "Example MCP",
  namespace: "examplemcp",
  transport: "http",
  url: "https://example.mcp.test",
  auth_config: { kind: "bearer", has_credential: true },
  status: "active",
  last_handshake_at: null,
  last_error: null,
  tools_manifest_hash: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
};

const STUB_SERVER_DISABLED = { ...STUB_SERVER, status: "disabled" };

// Capture the last create/patch body so tests can assert the write-only
// secret is forwarded on the wire but never printed back to the user.
let lastCreateBody: Record<string, unknown> | null = null;
let lastPatchBody: Record<string, unknown> | null = null;

// Drives the authorize poll loop: each inspectMcpServer call advances a
// status script so a test can make the loop terminate deterministically
// (active / still-pending) without real wall-clock dependence.
let authorizeUrlReturned: { authorization_url: string; state: string } | null = null;
let inspectMcpServerScript: Array<Record<string, unknown>> = [];
let inspectMcpServerCalls = 0;

mock.module("../engine-client.ts", () => ({
  ...ORIGINAL_ENGINE_CLIENT,
  EngineClient: class StubEngineClient {
    async createMcpServer(body: Record<string, unknown>) {
      lastCreateBody = body;
      return STUB_SERVER;
    }
    async patchMcpServer(_id: string, body: Record<string, unknown>) {
      lastPatchBody = body;
      return STUB_SERVER;
    }
    async listMcpServers() {
      return { items: [STUB_SERVER] };
    }
    async getMcpServer(_id: string) {
      return STUB_SERVER;
    }
    async authorizeMcpServer(_id: string) {
      const res = { authorization_url: "https://idp.test/authorize?x=1", state: "state-abc" };
      authorizeUrlReturned = res;
      return res;
    }
    async disableMcpServer(_id: string) {
      return STUB_SERVER_DISABLED;
    }
    async enableMcpServer(_id: string) {
      return STUB_SERVER;
    }
    async deleteMcpServer(_id: string) {
      return undefined;
    }
    async inspectMcpServer(_id: string) {
      if (inspectMcpServerScript.length > 0) {
        const idx = Math.min(inspectMcpServerCalls, inspectMcpServerScript.length - 1);
        inspectMcpServerCalls++;
        return inspectMcpServerScript[idx]!;
      }
      return {
        tools: [],
        status: "active",
        last_error: null,
        manifest_hash: null,
        last_handshake_at: null,
      };
    }
  },
}));

mock.module("../config.ts", () => ({
  ...ORIGINAL_CONFIG,
  resolveProfile: () => ({
    engine_url: "http://stub.test",
    api_key: "stub-key",
    active_tenant_id: "tnt-stub",
  }),
}));

// Import AFTER mocks are installed.
import { mcpServersCommand } from "./mcp-servers.ts";

// ── stdout / stderr capture ───────────────────────────────────────────────────

let stdoutBuf = "";
let stderrBuf = "";
const origStdout = process.stdout.write.bind(process.stdout);
const origStderr = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  stdoutBuf = "";
  stderrBuf = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutBuf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrBuf += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = origStdout;
  process.stderr.write = origStderr;
});

afterAll(() => {
  mock.module("../engine-client.ts", () => ORIGINAL_ENGINE_CLIENT);
  mock.module("../config.ts", () => ORIGINAL_CONFIG);
});

// ── helpers ───────────────────────────────────────────────────────────────────

type CittySub = {
  run?: (ctx: { args: Record<string, unknown> }) => Promise<unknown>;
};

function getSub(name: string): CittySub {
  const subs = (mcpServersCommand as { subCommands?: Record<string, CittySub> }).subCommands;
  const sub = subs?.[name];
  if (!sub?.run) throw new Error(`expected subCommands.${name}.run`);
  return sub;
}

// ── add ───────────────────────────────────────────────────────────────────────

describe("sk mcp-servers add · --json contract", () => {
  test("stdout is valid JSON with the returned server fields", async () => {
    const add = getSub("add");
    await add.run!({
      args: {
        name: "Example MCP",
        namespace: "examplemcp",
        transport: "http",
        url: "https://example.mcp.test",
        json: true,
      },
    });
    expect(() => JSON.parse(stdoutBuf.trim())).not.toThrow();
    const parsed = JSON.parse(stdoutBuf.trim()) as Record<string, unknown>;
    expect(parsed.id).toBe(STUB_SERVER.id);
    expect(parsed.namespace).toBe("examplemcp");
  });

  test("stderr is empty when --json is set", async () => {
    const add = getSub("add");
    await add.run!({
      args: {
        name: "Acme MCP",
        namespace: "acmemcp",
        transport: "http",
        url: "https://acme.mcp.test",
        json: true,
      },
    });
    expect(stderrBuf).toBe("");
  });

  test("--auth-kind is forwarded and auth_config.kind appears in JSON output", async () => {
    const add = getSub("add");
    await add.run!({
      args: {
        name: "Bearer MCP",
        namespace: "bearermcp",
        transport: "http",
        url: "https://bearer.mcp.test",
        "auth-kind": "bearer",
        json: true,
      },
    });
    const parsed = JSON.parse(stdoutBuf.trim()) as { auth_config?: { kind?: string } };
    expect(parsed.auth_config?.kind).toBe("bearer");
  });

  test("--token is sent in the create body as a write-only field, never printed", async () => {
    const SECRET = "sk-cli-bearer-secret-1234";
    const add = getSub("add");
    await add.run!({
      args: {
        name: "Bearer MCP",
        namespace: "bearermcp2",
        transport: "http",
        url: "https://bearer.mcp.test",
        "auth-kind": "bearer",
        token: SECRET,
        json: true,
      },
    });
    // Forwarded on the wire as a top-level write-only field…
    expect(lastCreateBody?.token).toBe(SECRET);
    // …and inside auth_config there is NO secret.
    expect(JSON.stringify(lastCreateBody?.auth_config)).not.toContain(SECRET);
    // …but the redacted response printed to stdout never contains it.
    expect(stdoutBuf).not.toContain(SECRET);
  });
});

describe("sk mcp-servers add · auth flag validation", () => {
  test("--auth-kind basic forwards --username + --token as write-only fields", async () => {
    const SECRET = "sk-cli-basic-secret-2468";
    const USERNAME = "user@basic.test";
    const add = getSub("add");
    await add.run!({
      args: {
        name: "Basic MCP",
        namespace: "basicmcp",
        transport: "http",
        url: "https://basic.mcp.test",
        "auth-kind": "basic",
        username: USERNAME,
        token: SECRET,
        json: true,
      },
    });
    // Both halves of the pair travel as top-level write-only fields…
    expect(lastCreateBody?.token).toBe(SECRET);
    expect(lastCreateBody?.username).toBe(USERNAME);
    // …auth_config carries only the kind…
    expect(JSON.stringify(lastCreateBody?.auth_config)).not.toContain(SECRET);
    expect(JSON.stringify(lastCreateBody?.auth_config)).not.toContain(USERNAME);
    // …and the secret is never printed.
    expect(stdoutBuf).not.toContain(SECRET);
  });

  test("rejects --auth-kind basic with --token but no --username before any request leaves the CLI", async () => {
    lastCreateBody = null;
    const add = getSub("add");
    let threw = false;
    try {
      await add.run!({
        args: {
          name: "Half Basic MCP",
          namespace: "halfbasicmcp",
          transport: "http",
          url: "https://halfbasic.mcp.test",
          "auth-kind": "basic",
          token: "lonely-token",
          json: true,
        },
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(lastCreateBody).toBeNull();
    const out = JSON.parse(stdoutBuf.trim()) as { error?: string };
    expect(out.error).toContain("--auth-kind basic requires --username and --token together");
  });

  test("rejects --refresh-token with --auth-kind basic before any request leaves the CLI", async () => {
    lastCreateBody = null;
    const add = getSub("add");
    let threw = false;
    try {
      await add.run!({
        args: {
          name: "Wrong Field Basic MCP",
          namespace: "wrongbasicmcp",
          transport: "http",
          url: "https://wrongbasic.mcp.test",
          "auth-kind": "basic",
          username: "u@x.test",
          token: "t",
          "refresh-token": "rt",
          json: true,
        },
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(lastCreateBody).toBeNull();
    const out = JSON.parse(stdoutBuf.trim()) as { error?: string };
    expect(out.error).toContain("--auth-kind basic uses --username plus --token");
  });

  test("rejects --token with --auth-kind oauth2 before any request leaves the CLI", async () => {
    lastCreateBody = null;
    const SECRET = "sk-wrong-field-secret-9999";
    const add = getSub("add");
    let threw = false;
    try {
      await add.run!({
        args: {
          name: "Mismatch MCP",
          namespace: "mismatchmcp",
          transport: "http",
          url: "https://mismatch.mcp.test",
          "auth-kind": "oauth2",
          token: SECRET,
          json: true,
        },
      });
    } catch {
      threw = true;
    }
    // reportCommandError re-throws so the dispatcher sets the exit code.
    expect(threw).toBe(true);
    // The request never left the CLI — validation fired first.
    expect(lastCreateBody).toBeNull();
    // Friendly, flag-naming error on stdout in --json mode…
    const out = JSON.parse(stdoutBuf.trim()) as { error?: string };
    expect(out.error).toContain("--auth-kind oauth2 uses --refresh-token, not --token");
    // …and the secret value itself is never echoed anywhere.
    expect(stdoutBuf).not.toContain(SECRET);
    expect(stderrBuf).not.toContain(SECRET);
  });
});

describe("sk mcp-servers set-credential · rotation", () => {
  test("--token rotates via patchMcpServer and never prints the secret", async () => {
    const SECRET = "sk-cli-rotate-secret-5678";
    const setCred = getSub("set-credential");
    await setCred.run!({
      args: {
        id: STUB_SERVER.id,
        "auth-kind": "bearer",
        token: SECRET,
        json: true,
      },
    });
    expect(lastPatchBody?.token).toBe(SECRET);
    expect((lastPatchBody?.auth_config as { kind?: string })?.kind).toBe("bearer");
    expect(stdoutBuf).not.toContain(SECRET);
    expect(stderrBuf).toBe("");
  });
});

// ── list ──────────────────────────────────────────────────────────────────────

describe("sk mcp-servers list · --json contract", () => {
  test("stdout is a JSON array", async () => {
    const list = getSub("list");
    await list.run!({ args: { json: true } });
    expect(() => JSON.parse(stdoutBuf.trim())).not.toThrow();
    const parsed = JSON.parse(stdoutBuf.trim());
    expect(Array.isArray(parsed)).toBe(true);
  });

  test("each item has the required fields", async () => {
    const list = getSub("list");
    await list.run!({ args: { json: true } });
    const parsed = JSON.parse(stdoutBuf.trim()) as Array<Record<string, unknown>>;
    expect(parsed.length).toBeGreaterThan(0);
    const item = parsed[0]!;
    expect(typeof item.id).toBe("string");
    expect(typeof item.name).toBe("string");
    expect(typeof item.namespace).toBe("string");
    expect(typeof item.status).toBe("string");
  });

  test("stderr is empty when --json is set", async () => {
    const list = getSub("list");
    await list.run!({ args: { json: true } });
    expect(stderrBuf).toBe("");
  });
});

// ── get ───────────────────────────────────────────────────────────────────────

describe("sk mcp-servers get · --json contract", () => {
  test("stdout is valid JSON with the server id", async () => {
    const get = getSub("get");
    await get.run!({ args: { id: STUB_SERVER.id, json: true } });
    expect(() => JSON.parse(stdoutBuf.trim())).not.toThrow();
    const parsed = JSON.parse(stdoutBuf.trim()) as Record<string, unknown>;
    expect(parsed.id).toBe(STUB_SERVER.id);
  });

  test("stderr is empty when --json is set", async () => {
    const get = getSub("get");
    await get.run!({ args: { id: STUB_SERVER.id, json: true } });
    expect(stderrBuf).toBe("");
  });
});

// ── disable ───────────────────────────────────────────────────────────────────

describe("sk mcp-servers disable · --json contract", () => {
  test("stdout JSON carries status === 'disabled'", async () => {
    const disable = getSub("disable");
    await disable.run!({ args: { id: STUB_SERVER.id, json: true } });
    const parsed = JSON.parse(stdoutBuf.trim()) as Record<string, unknown>;
    expect(parsed.status).toBe("disabled");
  });

  test("stderr is empty when --json is set", async () => {
    const disable = getSub("disable");
    await disable.run!({ args: { id: STUB_SERVER.id, json: true } });
    expect(stderrBuf).toBe("");
  });
});

// ── enable ────────────────────────────────────────────────────────────────────

describe("sk mcp-servers enable · --json contract", () => {
  test("stdout JSON carries status === 'active'", async () => {
    const enable = getSub("enable");
    await enable.run!({ args: { id: STUB_SERVER.id, json: true } });
    const parsed = JSON.parse(stdoutBuf.trim()) as Record<string, unknown>;
    expect(parsed.status).toBe("active");
  });

  test("stderr is empty when --json is set", async () => {
    const enable = getSub("enable");
    await enable.run!({ args: { id: STUB_SERVER.id, json: true } });
    expect(stderrBuf).toBe("");
  });
});

// ── remove ────────────────────────────────────────────────────────────────────

describe("sk mcp-servers remove · --yes flag", () => {
  test("--yes skips confirmation and writes 'deleted' to stdout", async () => {
    const remove = getSub("remove");
    await remove.run!({ args: { id: STUB_SERVER.id, yes: true } });
    expect(stdoutBuf).toContain("deleted");
  });
});

// ── authorize ─────────────────────────────────────────────────────────────────

describe("sk mcp-servers authorize · OAuth consent flow", () => {
  beforeEach(() => {
    authorizeUrlReturned = null;
    inspectMcpServerScript = [];
    inspectMcpServerCalls = 0;
  });

  test("--json emits { authorization_url, state }, no polling, stderr empty", async () => {
    const authorize = getSub("authorize");
    await authorize.run!({ args: { id: STUB_SERVER.id, json: true } });
    expect(() => JSON.parse(stdoutBuf.trim())).not.toThrow();
    const parsed = JSON.parse(stdoutBuf.trim()) as Record<string, unknown>;
    expect(parsed.authorization_url).toBe("https://idp.test/authorize?x=1");
    expect(parsed.state).toBe("state-abc");
    expect(stderrBuf).toBe("");
    // No poll in --json mode.
    expect(inspectMcpServerCalls).toBe(0);
  });

  test("prints the authorization URL and calls authorizeMcpServer", async () => {
    const authorize = getSub("authorize");
    // --no-wait avoids the 2s poll; --no-open avoids spawning a browser.
    await authorize.run!({
      args: { id: STUB_SERVER.id, "no-open": true, "no-wait": true },
    });
    expect(authorizeUrlReturned).not.toBeNull();
    expect(stdoutBuf).toContain("https://idp.test/authorize?x=1");
    expect(stdoutBuf).toContain("Open this URL");
    // --no-wait skips polling entirely.
    expect(inspectMcpServerCalls).toBe(0);
  });

  test("polling succeeds when a forced handshake (inspect) reports active", async () => {
    inspectMcpServerScript = [{ status: "active", last_error: null }];
    const authorize = getSub("authorize");
    await authorize.run!({ args: { id: STUB_SERVER.id, "no-open": true } });
    expect(inspectMcpServerCalls).toBe(1);
    expect(stdoutBuf).toContain("authorized — server is active");
  });

  test("an error inspect (consent not yet granted) means keep waiting, not failure", async () => {
    // First handshake still 401s (the user has not finished the browser
    // step); the second succeeds. The pre-fix poll read the row status and
    // either false-positived on the default `active` or terminated on the
    // parked `error` — both wrong.
    inspectMcpServerScript = [
      { status: "error", last_error: "authorization required" },
      { status: "active", last_error: null },
    ];
    const authorize = getSub("authorize");
    await authorize.run!({ args: { id: STUB_SERVER.id, "no-open": true } });
    expect(inspectMcpServerCalls).toBe(2);
    expect(stdoutBuf).toContain("authorized — server is active");
  }, 15_000);
});

// ── error discipline ──────────────────────────────────────────────────────────

describe("sk mcp-servers · error discipline", () => {
  test("network error with --json emits { error } to stdout; stderr empty", async () => {
    // Temporarily override the mock to throw.
    mock.module("../engine-client.ts", () => ({
      ...ORIGINAL_ENGINE_CLIENT,
      EngineClient: class ErrorClient {
        async listMcpServers(): Promise<never> {
          throw new Error("network timeout");
        }
      },
    }));

    // Re-import so the fresh mock is used (Bun module cache is live).
    const { mcpServersCommand: freshCmd } = await import("./mcp-servers.ts");
    const listSub = (freshCmd as { subCommands?: Record<string, CittySub> }).subCommands?.list;

    if (!listSub?.run) throw new Error("expected list subcommand");

    let threw = false;
    try {
      await listSub.run({ args: { json: true } });
    } catch {
      threw = true;
    }
    // reportCommandError re-throws so the dispatcher can set exitCode.
    expect(threw).toBe(true);
    expect(() => JSON.parse(stdoutBuf.trim())).not.toThrow();
    const out = JSON.parse(stdoutBuf.trim()) as Record<string, unknown>;
    expect(typeof out.error).toBe("string");
    expect(stderrBuf).toBe("");

    // Restore the non-throwing stub for subsequent tests.
    mock.module("../engine-client.ts", () => ({
      ...ORIGINAL_ENGINE_CLIENT,
      EngineClient: class StubEngineClient {
        async createMcpServer() {
          return STUB_SERVER;
        }
        async listMcpServers() {
          return { items: [STUB_SERVER] };
        }
        async getMcpServer() {
          return STUB_SERVER;
        }
        async disableMcpServer() {
          return STUB_SERVER_DISABLED;
        }
        async enableMcpServer() {
          return STUB_SERVER;
        }
        async deleteMcpServer() {
          return undefined;
        }
        async inspectMcpServer() {
          return {
            tools: [],
            status: "active",
            last_error: null,
            manifest_hash: null,
            last_handshake_at: null,
          };
        }
      },
    }));
  });

  test("network error WITHOUT --json writes to stderr; stdout stays empty", async () => {
    mock.module("../engine-client.ts", () => ({
      ...ORIGINAL_ENGINE_CLIENT,
      EngineClient: class ErrorClient {
        async getMcpServer(): Promise<never> {
          throw new Error("not found");
        }
      },
    }));

    const { mcpServersCommand: freshCmd } = await import("./mcp-servers.ts");
    const getSub2 = (freshCmd as { subCommands?: Record<string, CittySub> }).subCommands?.get;
    if (!getSub2?.run) throw new Error("expected get subcommand");

    let threw = false;
    try {
      await getSub2.run({ args: { id: "a0000000-0000-4000-8000-000000000001", json: false } });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(stderrBuf).toContain("not found");
    // stdoutBuf should be empty — no JSON emitted in non-json mode.
    expect(stdoutBuf).toBe("");

    // Restore.
    mock.module("../engine-client.ts", () => ({
      ...ORIGINAL_ENGINE_CLIENT,
      EngineClient: class StubEngineClient {
        async createMcpServer() {
          return STUB_SERVER;
        }
        async listMcpServers() {
          return { items: [STUB_SERVER] };
        }
        async getMcpServer() {
          return STUB_SERVER;
        }
        async disableMcpServer() {
          return STUB_SERVER_DISABLED;
        }
        async enableMcpServer() {
          return STUB_SERVER;
        }
        async deleteMcpServer() {
          return undefined;
        }
        async inspectMcpServer() {
          return {
            tools: [],
            status: "active",
            last_error: null,
            manifest_hash: null,
            last_handshake_at: null,
          };
        }
      },
    }));
  });
});
