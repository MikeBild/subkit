// Tests for the JSONataEngine wrapper: compile cache, structured
// errors with caret, parseDeps regex extractor, extractAst guard,
// flattenBindings shape.

import { afterEach, describe, expect, test } from "bun:test";
import {
  _resetCacheForTests,
  compile,
  evaluate,
  extractAst,
  flattenBindings,
  JSONataError,
  parseDeps,
} from "../jsonata-engine.ts";

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
});

describe("structured errors", () => {
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
    // $sum requires an array; calling it on a string raises a type
    // error inside JSONata which the wrapper rewraps.
    let caught: unknown;
    try {
      await evaluate("$sum($)", "not-an-array");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(JSONataError);
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
});

describe("flattenBindings", () => {
  test("includes core namespaces with sensible defaults", () => {
    const flat = flattenBindings({});
    expect(flat).toEqual({
      input: null,
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
