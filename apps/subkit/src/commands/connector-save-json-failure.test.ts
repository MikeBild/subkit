import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const realEngineClient = await import("../engine-client.ts");
const realConfig = await import("../config.ts");

const ORIGINAL_ENGINE_CLIENT = { ...realEngineClient };
const ORIGINAL_CONFIG = { ...realConfig };

const engineCalls = { createConnector: 0, patchConnector: 0 };
const engineState = {
  validate: { ok: true, issues: [] } as {
    ok: boolean;
    issues: Array<{ path: string; message: string }>;
  },
  probe: { ok: false, latency_ms: 4, detail: "upstream refused" } as Record<string, unknown>,
};

class StubEngineClient {
  async validateConnectorDraft() {
    return engineState.validate;
  }
  async probeConnectorDraft() {
    return engineState.probe;
  }
  async getConnector(id: string) {
    return { id, name: "Stub", slug: "stub", driver: "http", auth_type: "none", config: {} };
  }
  async createConnector() {
    engineCalls.createConnector += 1;
    return { id: "c1", slug: "stub", auth_type: "none" };
  }
  async patchConnector() {
    engineCalls.patchConnector += 1;
    return { id: "c1", slug: "stub", auth_type: "none" };
  }
}

mock.module("../engine-client.ts", () => ({
  ...ORIGINAL_ENGINE_CLIENT,
  EngineClient: StubEngineClient,
}));

mock.module("../config.ts", () => ({
  ...ORIGINAL_CONFIG,
  resolveProfile: () => ({
    engine_url: "http://stub.test",
    api_key: "stub-key",
    active_tenant_id: "tnt-test",
  }),
}));

import { connectorsCommand } from "./connectors.ts";

type CittySub = { run?: (ctx: { args: Record<string, unknown> }) => Promise<unknown> };

function subCommand(name: string): CittySub {
  const sub = (connectorsCommand as { subCommands?: Record<string, CittySub> }).subCommands;
  const found = sub?.[name];
  if (!found?.run) throw new Error(`expected subCommands.${name}.run`);
  return found;
}

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

let stdoutBuffer = "";
let stderrBuffer = "";
let exits: Array<{ code: number; stdout: string }> = [];
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalExit = process.exit;

beforeEach(() => {
  stdoutBuffer = "";
  stderrBuffer = "";
  exits = [];
  engineCalls.createConnector = 0;
  engineCalls.patchConnector = 0;
  engineState.validate = { ok: true, issues: [] };
  engineState.probe = { ok: false, latency_ms: 4, detail: "upstream refused" };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdoutBuffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderrBuffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    exits.push({ code: code ?? 0, stdout: stdoutBuffer });
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
});

afterEach(() => {
  process.stdout.write = originalStdoutWrite;
  process.stderr.write = originalStderrWrite;
  process.exit = originalExit;
});

afterAll(() => {
  mock.module("../engine-client.ts", () => ORIGINAL_ENGINE_CLIENT);
  mock.module("../config.ts", () => ORIGINAL_CONFIG);
});

function definitionFile(): string {
  const path = join(mkdtempSync(join(tmpdir(), "subkit-connector-save-")), "c.json");
  writeFileSync(
    path,
    JSON.stringify({ name: "Stub", driver: "http", auth_type: "none", config: {} }),
    "utf8",
  );
  return path;
}

async function exitCodeOf(run: Promise<unknown>): Promise<number | undefined> {
  await run.catch(() => undefined);
  return exits[0]?.code;
}

function stdoutBeforeExit(): Record<string, unknown> & { error: Record<string, unknown> } {
  return JSON.parse(exits[0]?.stdout ?? "");
}

describe("connectors create --file --json · failed pre-save check", () => {
  test("probe failure prints a JSON failure and exits 64 without saving", async () => {
    const code = await exitCodeOf(
      subCommand("create").run!({ args: { file: definitionFile(), json: true } }),
    );
    expect(code).toBe(64);
    expect(engineCalls.createConnector).toBe(0);
    const parsed = stdoutBeforeExit();
    expect(parsed.created).toBe(false);
    expect(parsed.stage).toBe("probe");
    expect(parsed.error).toEqual({ code: "CONNECTOR_PROBE_FAILED", message: "upstream refused" });
  });

  test("missing credentials retain the actionable text hint", async () => {
    engineState.probe = { ok: false, error_code: "credential_missing" };
    const code = await exitCodeOf(subCommand("create").run!({ args: { file: definitionFile() } }));
    expect(code).toBe(64);
    expect(engineCalls.createConnector).toBe(0);
    expect(stderrBuffer).toContain("--credential <file>");
  });

  test("validate failure prints a JSON failure with issues and exits 1 without saving", async () => {
    engineState.validate = { ok: false, issues: [{ path: "base_url", message: "required" }] };
    const code = await exitCodeOf(
      subCommand("create").run!({ args: { file: definitionFile(), json: true } }),
    );
    expect(code).toBe(1);
    expect(engineCalls.createConnector).toBe(0);
    const parsed = stdoutBeforeExit();
    expect(parsed.created).toBe(false);
    expect(parsed.stage).toBe("validate");
    expect(parsed.error.code).toBe("CONNECTOR_VALIDATE_FAILED");
    expect(parsed.error.issues).toEqual([{ path: "base_url", message: "required" }]);
  });
});

describe("connectors patch --file --json · failed pre-save check", () => {
  test("validate failure prints updated:false and exits 1 without patching", async () => {
    engineState.validate = { ok: false, issues: [{ path: "name", message: "too long" }] };
    const code = await exitCodeOf(
      subCommand("patch").run!({ args: { id: "c1", file: definitionFile(), json: true } }),
    );
    expect(code).toBe(1);
    expect(engineCalls.patchConnector).toBe(0);
    const parsed = stdoutBeforeExit();
    expect(parsed.updated).toBe(false);
    expect(parsed.stage).toBe("validate");
  });
});
