// Determinism is tamper-proof: the host injects the deterministic
// clock/seed as VM globals (`__sandbox_now__` / `__sandbox_seed__`) BEFORE
// the stdlib installs. The stdlib must capture them ONCE into closure
// consts and DELETE the writable globals — otherwise untrusted user JS
// could overwrite them between `sk.now()` / `sk.uuid()` calls and corrupt
// determinism (two calls in one run observing different clocks/seeds).
//
// These tests run real user JS inside the QuickJS sandbox via `runJs`,
// exactly the path production transforms use.

import { describe, expect, test } from "bun:test";
import { runJs } from "../../runtime.ts";

const FIXED_NOW = 1_717_000_000_000; // a fixed, non-zero instant
const SEED = "exec-abc:step-1";

describe("sk.now()/sk.uuid() determinism is tamper-proof", () => {
  test("user code reassigning globalThis.__sandbox_now__ = 0 does NOT change sk.now()", async () => {
    // The classic attack: stash now(), clobber the (formerly) backing
    // global, then read now() again. With the capture-once + delete fix
    // both reads return the injected instant.
    const code = `
      const before = sk.now();
      globalThis.__sandbox_now__ = 0;
      const after = sk.now();
      return { before, after };
    `;
    const r = await runJs<{ before: number; after: number }>({
      code,
      input: {},
      clock: { now_ms: FIXED_NOW, seed: SEED },
    });
    expect(r.output.before).toBe(FIXED_NOW);
    expect(r.output.after).toBe(FIXED_NOW);
  });

  test("the backing globals are deleted — user code cannot even read them", async () => {
    const code = `
      return {
        now_global: typeof globalThis.__sandbox_now__,
        seed_global: typeof globalThis.__sandbox_seed__,
      };
    `;
    const r = await runJs<{ now_global: string; seed_global: string }>({
      code,
      input: {},
      clock: { now_ms: FIXED_NOW, seed: SEED },
    });
    expect(r.output.now_global).toBe("undefined");
    expect(r.output.seed_global).toBe("undefined");
  });

  test("reassigning the seed global does NOT change sk.uuid() derivation", async () => {
    const code = `
      globalThis.__sandbox_seed__ = "attacker-seed";
      return sk.uuid();
    `;
    const tampered = await runJs<string>({
      code,
      input: {},
      clock: { now_ms: FIXED_NOW, seed: SEED },
    });
    // A clean run with the same injected seed and no tampering must
    // produce the identical first uuid — proving the global write was
    // ignored.
    const clean = await runJs<string>({
      code: "return sk.uuid();",
      input: {},
      clock: { now_ms: FIXED_NOW, seed: SEED },
    });
    expect(tampered.output).toBe(clean.output);
  });

  test("sk.now() stays fixed across many calls in one run", async () => {
    const code = `
      const samples = [];
      for (let i = 0; i < 5; i++) {
        globalThis.__sandbox_now__ = i; // try to drift it each iteration
        samples.push(sk.now());
      }
      return samples;
    `;
    const r = await runJs<number[]>({
      code,
      input: {},
      clock: { now_ms: FIXED_NOW, seed: SEED },
    });
    expect(r.output).toEqual([FIXED_NOW, FIXED_NOW, FIXED_NOW, FIXED_NOW, FIXED_NOW]);
  });
});
