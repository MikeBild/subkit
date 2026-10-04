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
    const result = await runJs<{ has_process: boolean }>({
      code: "return { has_process: typeof process !== 'undefined' }",
      input: null,
      clock: null,
    });
    expect(result.output.has_process).toBe(false);
  });
});
