import { describe, expect, test } from "bun:test";
import { runJs } from "../../runtime.ts";

const FIXED_NOW = 1_717_000_000_000;
const SEED = "exec-abc:step-1";

describe("sk.now()/sk.uuid() determinism is tamper-proof", () => {
  test("user code reassigning globalThis.__sandbox_now__ = 0 does NOT change sk.now()", async () => {
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

test("legacy Date calls share the fixed clock while explicit dates retain their meaning", async () => {
  const { output } = await runJs({
    // allow-wall-clock: guest source must exercise the fixed legacy Date API itself.
    code: "return [Date.now(), new Date().getTime(), new Date(0).getTime(), Date.parse('2020-01-01T00:00:00Z'), new Date() instanceof Date];",
    input: {},
    clock: { now_ms: FIXED_NOW, seed: SEED },
  });
  expect(output).toEqual([FIXED_NOW, FIXED_NOW, 0, 1577836800000, true]);
});
