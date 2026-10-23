import { describe, expect, test } from "bun:test";
import { runJs } from "../runtime.ts";
import { pruneScopeForJs, resolveJsScopeReferences } from "../scope-references.ts";

const SCOPE = {
  fetch_a: { data: { items: [1, 2, 3] }, status_code: 200 },
  fetch_b: { data: { name: "b" }, status_code: 200 },
  "odd-id": { data: { flag: true } },
  unused: { data: { large: "x".repeat(10_000) } },
};

describe("scope references", () => {
  test("resolves dotted, optional and bracketed scope access", () => {
    expect(
      resolveJsScopeReferences(
        'const a = input.scope.fetch_a.data; const b = input?.scope?.fetch_b; const c = input.scope["odd-id"]; return { a, b, c, cfg: input.input };',
      ),
    ).toEqual(["fetch_a", "fetch_b", "odd-id"]);
  });

  test("falls back when scope or input is used in an unresolvable way", () => {
    for (const code of [
      "const s = input.scope; return s.fetch_a;",
      "return Object.keys(input.scope);",
      "const key = 'fetch_a'; return input.scope[key];",
      "return JSON.stringify(input);",
      "const { scope } = input; return scope.fetch_a;",
      "return arguments[0].scope.fetch_a;",
      "return globalThis.__sandbox_input__.scope.fetch_a;",
      "return eval('input.scope.fetch_a');",
      "return input.scope.hasOwnProperty('fetch_a');",
      "return input.scope?.hasOwnProperty?.('fetch_a');",
      "return input.scope.constructor === Object;",
      "return input.scope.toString();",
    ]) {
      expect(resolveJsScopeReferences(code)).toBeNull();
    }
  });

  test("prunes to referenced steps and keeps the full scope on fallback", () => {
    const pruned = pruneScopeForJs("return input.scope.fetch_a.data.items.length;", SCOPE);
    expect(pruned.pruned).toBe(true);
    expect(Object.keys(pruned.scope)).toEqual(["fetch_a"]);
    const missing = pruneScopeForJs("return input.scope.not_run ?? null;", SCOPE);
    expect(missing.scope).toEqual({});
    const full = pruneScopeForJs("return Object.keys(input.scope).length;", SCOPE);
    expect(full.pruned).toBe(false);
    expect(full.scope).toBe(SCOPE);
  });

  test("produces the same output with and without pruning", async () => {
    const programs = [
      "const a = input.scope.fetch_a.data.items; return { sum: a.reduce((x, y) => x + y, 0), name: input.scope.fetch_b.data.name, flag: input.scope['odd-id'].data.flag, cfg: input.input };",
      "return input.scope.not_run === undefined ? sk.nowIso() : 'ran';",
      "return Object.keys(input.scope).sort();",
      "const s = input.scope; return s.unused.data.large.length;",
      "return input.scope.hasOwnProperty('fetch_a');",
      "return input.scope.constructor === Object;",
    ];
    for (const code of programs) {
      const workflowInput = { mode: "daily" };
      const clock = { now_ms: Date.UTC(2026, 9, 23, 12), seed: "scope-pruning" };
      const full = await runJs({ code, input: { scope: SCOPE, input: workflowInput }, clock });
      const pruned = await runJs({
        code,
        input: { scope: pruneScopeForJs(code, SCOPE).scope, input: workflowInput },
        clock,
      });
      expect(pruned.output).toEqual(full.output);
    }
  });
});
