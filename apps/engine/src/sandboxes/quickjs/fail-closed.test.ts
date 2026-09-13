// Fail-closed invariant: if the QuickJS WASM module fails to load
// for any reason, `runJs` MUST throw — there is no host-eval fallback,
// no silent skip, no "best-effort" host `Function(...)` evaluation.
// All untrusted JS (including RBAC custom-rule expressions) runs in
// QuickJS and never falls back to a raw host `new Function(…)`, even
// when the inputs are admin-defined. This test proves the contract
// holds when the WASM loader rejects.

import { afterEach, describe, expect, test } from "bun:test";

import { runJs, setQuickJsModuleProviderForTesting } from "./runtime.ts";

describe("quickjs runtime · fail-closed invariant", () => {
  afterEach(() => {
    setQuickJsModuleProviderForTesting(null);
  });

  test("runJs throws when the WASM module loader rejects (no host-eval fallback)", async () => {
    setQuickJsModuleProviderForTesting(async () => {
      throw new Error("simulated wasm load failure");
    });
    let threw = false;
    try {
      await runJs({ code: "return 1 + 1", input: null, clock: null });
    } catch (err) {
      threw = true;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/simulated wasm load failure/);
    }
    expect(threw).toBe(true);
  });

  test("user code is never executed in the host context — host globals stay invisible", async () => {
    // Smoke check: the production loader returns a clean QuickJS VM.
    // `process` is a host global; user code attempting to read it must
    // see undefined inside the sandbox. This pins the second half of
    // the invariant — even when QuickJS DOES load, we never bridge the
    // host scope.
    const result = await runJs<{ has_process: boolean }>({
      code: "return { has_process: typeof process !== 'undefined' }",
      input: null,
      clock: null,
    });
    expect(result.output.has_process).toBe(false);
  });
});
