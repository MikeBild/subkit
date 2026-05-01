// Lock-the-lead invariant: if the QuickJS WASM module fails to load
// for any reason, `runJs` MUST throw — there is no host-eval fallback,
// no silent skip, no "best-effort" host `Function(...)` evaluation. A
// reference implementation evaluates RBAC custom-rule expressions with
// raw `new Function(…)` even though the inputs are admin-defined; we
// run all untrusted JS in QuickJS and never fall back to host. This
// test proves the contract holds when the WASM loader rejects.

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
      await runJs({ code: "return 1 + 1", input: null });
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
    });
    expect(result.output.has_process).toBe(false);
  });
});
