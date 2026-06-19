// Two properties of the sandbox limit plumbing:
//
//   1. The effective default limits are sourced from engine config
//      (`sandbox.*`) — a `runJs` call with NO per-call overrides honors
//      the configured caps, not just the static DEFAULT_LIMITS.
//   2. The stack cap is a real knob: deep recursion that fits inside the
//      2 MB default fails outright under a tiny stack budget.
//
// Both reset the config singleton in afterEach so the no-config fallback
// (DEFAULT_LIMITS) is restored for the other sandbox test files sharing
// this process.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
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
    // 24 MB cap via config override. A 64 MB allocation would succeed under
    // the 128 MB static default, so its failure here proves the configured
    // cap — not DEFAULT_LIMITS — is what `runJs` applied.
    await loadConfig({
      env: { ...BASE_ENV, SK_OVERRIDE_SANDBOX_MEMORY_BYTES: String(24 * 1024 * 1024) },
      configPathOverride: join(dir, "subkit.config.json"),
    });

    let threw: unknown = null;
    try {
      await runJs({
        code: "const big = new Uint8Array(64 * 1024 * 1024); big[0] = 1; return big.length;",
        input: null,
      });
    } catch (err) {
      threw = err;
    }
    // memory cap, or an interrupt/timeout the allocator tripped first.
    expect(threw).toBeInstanceOf(SandboxError);
  });

  test("a configured tick budget aborts a runaway loop", async () => {
    await loadConfig({
      env: { ...BASE_ENV, SK_OVERRIDE_SANDBOX_TICK_BUDGET: "2001" },
      configPathOverride: join(dir, "subkit.config.json"),
    });

    let threw: unknown = null;
    try {
      await runJs({ code: "let i = 0; while (true) { i += 1; } return i;", input: null });
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
    const { output } = await runJs<number>({ code: recursion, input: null });
    expect(output).toBe(1500);
  });

  test("the same recursion overflows a tiny stack budget", async () => {
    let threw: unknown = null;
    try {
      await runJs({ code: recursion, input: null, limits: { stack_bytes: 64 * 1024 } });
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(SandboxError);
  });
});
