import { afterEach, describe, expect, test } from "bun:test";
import { SandboxTimeoutError } from "../../sandboxes/index.ts";
import {
  _resetCacheForTests,
  compile,
  evaluate,
  extractAst,
  findUnboundFunctionCalls,
  flattenBindings,
  formatError,
  isJSONataSandboxTimeout,
  JSONataError,
  parseDeps,
} from "../jsonata-engine.ts";
import { sensitiveFailure } from "../sensitive-payload.ts";

afterEach(() => {
  _resetCacheForTests();
});

describe("compile cache", () => {
  test("returns the same Expression for the same source", () => {
    const a = compile("$.foo");
    const b = compile("$.foo");
    expect(a).toBe(b);
  });

  test("different sources produce different Expressions", () => {
    const a = compile("$.foo");
    const b = compile("$.bar");
    expect(a).not.toBe(b);
  });

  test("rejects nondeterministic builtins", () => {
    expect(() => compile("$random()")).toThrow(JSONataError);
    expect(() => compile("$shuffle([1, 2])")).toThrow(JSONataError);
  });

  test("rejects nondeterministic aliases at evaluation", async () => {
    await expect(evaluate("($r := $random; $r())", {})).rejects.toBeInstanceOf(JSONataError);
  });
});

describe("structured errors", () => {
  test("preserves a typed sandbox timeout without disclosing its contents in a sensitive result", () => {
    const original = new SandboxTimeoutError("PRIVATE_TIMEOUT_CANARY");
    const wrapped = formatError(original, "$input.PRIVATE_EXPRESSION_CANARY");
    expect(wrapped.cause).toBe(original);
    expect(isJSONataSandboxTimeout(wrapped)).toBe(true);
    const result = sensitiveFailure(
      isJSONataSandboxTimeout(wrapped) ? "timed_out" : "branch_error",
    );
    expect(result).toEqual({ code: "timed_out", message: "Sensitive execution failed." });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_");
  });

  test("does not classify payload text or a forged timeout shape as a sandbox timeout", () => {
    for (const original of [
      new Error("sandbox worker exceeded wall-clock budget"),
      { name: "SandboxTimeoutError", cause_kind: "timeout", message: "PRIVATE_TIMEOUT_CANARY" },
    ]) {
      const wrapped = formatError(original, "$input");
      expect(isJSONataSandboxTimeout(wrapped)).toBe(false);
      expect(sensitiveFailure("branch_error").code).toBe("sensitive_execution_failure");
    }
  });

  test("throws JSONataError with caret-pointed source on parse failure", () => {
    let caught: unknown;
    try {
      compile("$.invalid syntax (");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JSONataError);
    const e = caught as JSONataError;
    expect(e.source).toBe("$.invalid syntax (");
    expect(typeof e.message).toBe("string");
  });

  test("evaluation errors also wrap as JSONataError", async () => {
    let caught: unknown;
    try {
      await evaluate("$sum($)", "not-an-array");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JSONataError);
  });

  test("formatError coerces an object-shaped .message instead of '[object Object]'", () => {
    const wrapped = formatError({ message: { code: "T9999", detail: "boom" } }, "$.foo");
    expect(wrapped).toBeInstanceOf(JSONataError);
    expect(wrapped.message).not.toContain("[object Object]");
    expect(wrapped.message).toContain("T9999");
    expect(wrapped.message).toContain("boom");
  });

  test("formatError handles a throw value with no .message at all", () => {
    const wrapped = formatError({ position: 4 }, "$.bar");
    expect(wrapped).toBeInstanceOf(JSONataError);
    expect(wrapped.message).toContain("JSONata error");
    expect(wrapped.message).not.toContain("[object Object]");
  });

  test("formatError preserves a normal string .message untouched", () => {
    const wrapped = formatError(
      { message: "Function 'foo' not found", position: 7, token: "foo" },
      "$.baz",
    );
    expect(wrapped).toBeInstanceOf(JSONataError);
    expect(wrapped.message).toContain("Function 'foo' not found");
    expect(wrapped.token).toBe("foo");
  });
});

describe("evaluate", () => {
  test("walks data root", async () => {
    const out = await evaluate("$.a", { a: 42 });
    expect(out).toBe(42);
  });

  test("exposes typed bindings as $-prefixed names", async () => {
    const out = await evaluate("$input.x", null, { input: { x: 7 } });
    expect(out).toBe(7);
  });

  test("loop_index / loop_item bindings reach JSONata", async () => {
    const out = await evaluate("$loop_index & ':' & $loop_item", null, {
      loop_index: 3,
      loop_item: "hi",
    });
    expect(out).toBe("3:hi");
  });

  test("uses the execution clock for now and millis", async () => {
    const nowMs = 1_700_000_000_000;
    const out = await evaluate("[$millis(), $now()]", {}, { clock: { now_ms: nowMs } });
    expect(out).toEqual([nowMs, new Date(nowMs).toISOString()]);
  });

  test("uses current time when no execution clock is supplied", async () => {
    const out = await evaluate("$millis()", {});
    expect(out).toBeGreaterThan(1_000_000_000_000);
  });

  test("does not retain bindings from an earlier worker job", async () => {
    await expect(
      evaluate("$cred.api.token", {}, { cred: { api: { token: "private" } } }),
    ).resolves.toBe("private");
    await expect(evaluate("$cred.api.token", {}, {})).resolves.toBeUndefined();
  });

  test("terminates a stalled expression and accepts the next job", async () => {
    await expect(
      evaluate("$reduce([1..100000000], function($a, $b) { $a + $b }, 0)", {}),
    ).rejects.toBeInstanceOf(JSONataError);
    await expect(evaluate("$.healthy", { healthy: true })).resolves.toBe(true);
  });
});

describe("flattenBindings", () => {
  test("includes core namespaces with sensible defaults", () => {
    const flat = flattenBindings({});
    expect(flat).toEqual({
      input: null,
      caller: null,
      scope: {},
      cred: {},
      connector: {},
      env: {},
    });
  });

  test("only includes loop_* when present", () => {
    const flat = flattenBindings({ loop_index: 0 });
    expect("loop_index" in flat).toBe(true);
    expect("loop_item" in flat).toBe(false);
  });
});

describe("parseDeps", () => {
  test("extracts inputs / scope / creds / connectors / env", () => {
    const deps = parseDeps(
      "$input.a + $scope.s1.data + $cred.stripe.key + $connector.slack.base_url + $env.HOME",
    );
    expect(deps.inputs).toEqual(["a"]);
    expect(deps.steps).toEqual(["s1"]);
    expect(deps.creds).toEqual(["stripe.key"]);
    expect(deps.connectors).toEqual(["slack.base_url"]);
    expect(deps.env).toEqual(["HOME"]);
  });

  test("collapses duplicate references", () => {
    const deps = parseDeps("$input.a + $input.a");
    expect(deps.inputs).toEqual(["a"]);
  });

  test("returns empty arrays for expressions with no namespaced references", () => {
    const deps = parseDeps("1 + 2");
    expect(deps.inputs).toEqual([]);
    expect(deps.steps).toEqual([]);
  });
});

describe("extractAst", () => {
  test("returns a non-null AST for a valid expression", () => {
    const ast = extractAst("$.foo");
    expect(ast).not.toBeNull();
  });

  test("returns null for an invalid expression", () => {
    const ast = extractAst("invalid syntax (");
    expect(ast).toBeNull();
  });
});

describe("findUnboundFunctionCalls", () => {
  test("finds bare calls that compile but cannot resolve at runtime", () => {
    expect(findUnboundFunctionCalls("not(boolean(1))")).toEqual([
      { name: "not", position: 3, suggestion: "$not" },
      { name: "boolean", position: 11, suggestion: "$boolean" },
    ]);
  });

  test("allows built-ins and bound function variables", () => {
    expect(findUnboundFunctionCalls("($f := function($x) { $not($x) }; $f(false))")).toEqual([]);
  });
});
