import { describe, expect, test } from "bun:test";
import { runJs } from "../../runtime.ts";

// Stdlib behavior is validated inside the QuickJS sandbox — not by
// evaluating stdlib.js in Node — so the tests exercise the same
// execution environment user code will see.

describe("sk.http.isMutating / isSafe", () => {
  test("classifies write methods as mutating", async () => {
    const { output } = await runJs<Record<string, boolean>>({
      code: "return { post: sk.http.isMutating('POST'), put: sk.http.isMutating('PUT'), patch: sk.http.isMutating('PATCH'), del: sk.http.isMutating('DELETE') };",
      input: null,
      clock: null,
    });
    expect(output.post).toBe(true);
    expect(output.put).toBe(true);
    expect(output.patch).toBe(true);
    expect(output.del).toBe(true);
  });

  test("classifies read methods as safe", async () => {
    const { output } = await runJs<Record<string, boolean>>({
      code: "return { get: sk.http.isSafe('GET'), head: sk.http.isSafe('HEAD'), opts: sk.http.isSafe('OPTIONS') };",
      input: null,
      clock: null,
    });
    expect(output.get).toBe(true);
    expect(output.head).toBe(true);
    expect(output.opts).toBe(true);
  });

  test("is case-insensitive", async () => {
    const { output } = await runJs<Record<string, boolean>>({
      code: "return { lower: sk.http.isMutating('post'), mixed: sk.http.isMutating('Put'), safeLower: sk.http.isSafe('get') };",
      input: null,
      clock: null,
    });
    expect(output.lower).toBe(true);
    expect(output.mixed).toBe(true);
    expect(output.safeLower).toBe(true);
  });

  test("handles non-string input defensively", async () => {
    const { output } = await runJs<Record<string, boolean>>({
      code: "return { nil: sk.http.isMutating(null), num: sk.http.isMutating(42), obj: sk.http.isMutating({}) };",
      input: null,
      clock: null,
    });
    expect(output.nil).toBe(false);
    expect(output.num).toBe(false);
    expect(output.obj).toBe(false);
  });

  test("exposes METHODS arrays", async () => {
    const { output } = await runJs<{ read: string[]; write: string[] }>({
      code: "return { read: sk.http.METHODS.READ, write: sk.http.METHODS.WRITE };",
      input: null,
      clock: null,
    });
    expect(output.read).toEqual(["GET", "HEAD", "OPTIONS"]);
    expect(output.write).toEqual(["POST", "PUT", "PATCH", "DELETE"]);
  });
});
