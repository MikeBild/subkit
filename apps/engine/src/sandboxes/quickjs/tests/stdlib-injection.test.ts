import { describe, expect, test } from "bun:test";
import { runJs } from "../runtime.ts";
import { STDLIB_VERSION } from "../stdlib/index.ts";

describe("sk-stdlib injection", () => {
  test("sk is available, frozen, and versioned in every sandbox", async () => {
    const { output } = await runJs<{
      hasSk: boolean;
      frozen: boolean;
      version: string;
      http: boolean;
    }>({
      code: `return {
        hasSk: typeof sk === 'object' && sk !== null,
        frozen: Object.isFrozen(sk),
        version: sk.version,
        http: typeof sk.http.isMutating === 'function'
      };`,
      input: null,
      clock: null,
    });
    expect(output.hasSk).toBe(true);
    expect(output.frozen).toBe(true);
    expect(output.version).toBe(STDLIB_VERSION);
    expect(output.http).toBe(true);
  });

  test("stdlib behavior matches the inline hook from journey 12", async () => {
    const cases = [
      { method: "GET", allow: true },
      { method: "HEAD", allow: true },
      { method: "POST", allow: false },
      { method: "PUT", allow: false },
      { method: "PATCH", allow: false },
      { method: "DELETE", allow: false },
      { method: "post", allow: false },
    ];

    for (const c of cases) {
      const { output } = await runJs<{ allow: boolean; reason?: string }>({
        code: `return sk.http.isMutating(sk.get(input, 'request.method', ''))
                 ? sk.deny('mutating_denied')
                 : sk.allow();`,
        input: { request: { method: c.method } },
        clock: null,
      });
      expect(output.allow).toBe(c.allow);
      if (!c.allow) {
        expect(output.reason).toBe("mutating_denied");
      }
    }
  });

  test("sk does not leak host globals", async () => {
    const { output } = await runJs<Record<string, string>>({
      code: `return {
        fetch: typeof fetch,
        process: typeof process,
        require: typeof require,
        sk: typeof sk
      };`,
      input: null,
      clock: null,
    });
    expect(output.fetch).toBe("undefined");
    expect(output.process).toBe("undefined");
    expect(output.require).toBe("undefined");
    expect(output.sk).toBe("object");
  });

  test("each sandbox call gets a fresh, unmodified sk", async () => {
    await runJs({
      code: "try { sk.allow = function(){ return { allow: false } }; } catch(e){} return null;",
      input: null,
      clock: null,
    });
    const { output } = await runJs<{ allow: boolean }>({
      code: "return sk.allow();",
      input: null,
      clock: null,
    });
    expect(output).toEqual({ allow: true });
  });
});
