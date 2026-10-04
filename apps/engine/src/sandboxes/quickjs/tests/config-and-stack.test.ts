import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetConfigForTests, loadConfig } from "../../../config/loader.ts";
import { runJs } from "../runtime.ts";
import { SandboxError } from "../types.ts";

let dir: string;
const BASE_ENV = { DATABASE_URL: "postgres://x:y@127.0.0.1:5432/z", NODE_ENV: "test" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sk-sandbox-cfg-"));
  _resetConfigForTests();
});

afterEach(() => {
  _resetConfigForTests();
  rmSync(dir, { recursive: true, force: true });
});

describe("sandbox limits are sourced from config", () => {
  test("a configured memory cap is enforced without per-call overrides", async () => {
    const configPath = join(dir, "subkit.config.json");
    writeFileSync(configPath, JSON.stringify({ sandbox: { memory_bytes: 24 * 1024 * 1024 } }));
    await loadConfig({ env: BASE_ENV, configPathOverride: configPath });

    let threw: unknown = null;
    try {
      await runJs({
        code: "const big = new Uint8Array(64 * 1024 * 1024); big[0] = 1; return big.length;",
        input: null,
        clock: null,
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(SandboxError);
  });

  test("a configured tick budget aborts a runaway loop", async () => {
    const configPath = join(dir, "subkit.config.json");
    writeFileSync(configPath, JSON.stringify({ sandbox: { tick_budget: 2001 } }));
    await loadConfig({ env: BASE_ENV, configPathOverride: configPath });

    let threw: unknown = null;
    try {
      await runJs({
        code: "let i = 0; while (true) { i += 1; } return i;",
        input: null,
        clock: null,
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(SandboxError);
    expect((threw as SandboxError).cause_kind === "interrupt").toBe(true);
  });
});

describe("stack cap", () => {
  const recursion = `
    function depth(n) { return n <= 0 ? 0 : 1 + depth(n - 1); }
    return depth(1500);
  `;

  test("deep recursion fits inside the 2 MB default stack", async () => {
    const { output } = await runJs<number>({ code: recursion, input: null, clock: null });
    expect(output).toBe(1500);
  });

  test("the same recursion overflows a tiny stack budget", async () => {
    let threw: unknown = null;
    try {
      await runJs({
        code: recursion,
        input: null,
        limits: { stack_bytes: 64 * 1024 },
        clock: null,
      });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(SandboxError);
  });
});
