import { describe, expect, test } from "bun:test";
import {
  compile,
  extractAst,
  findUnboundFunctionCalls,
  findUnknownFunctionCalls,
  formatError,
  JSONATA_FUNCTION_SUGGESTIONS,
  JSONataError,
  parseDeps,
} from "./jsonata-contract.ts";

describe("JSONata contract boundaries", () => {
  test("rejects every nondeterministic callable spelling before compilation", () => {
    for (const source of ["$random()", "$ shuffle([1])", "$\teval('1')", "$ShUfFlE([1])"]) {
      expect(() => compile(source)).toThrow(JSONataError);
      expect(() => compile(source)).toThrow(
        "JSONata random, shuffle, and eval functions are not available in deterministic execution",
      );
    }
  });

  test("enforces the source-size boundary in bytes, not characters", async () => {
    const accepted = `1${" ".repeat(256 * 1024 - 1)}`;
    expect(Buffer.byteLength(accepted)).toBe(256 * 1024);
    await expect(compile(accepted).evaluate({})).resolves.toBe(1);

    const rejected = `${accepted} `;
    expect(Buffer.byteLength(rejected)).toBe(256 * 1024 + 1);
    expect(() => compile(rejected)).toThrow("JSONata expression exceeds the maximum source length");
  });

  test("rejects an AST deeper than the supported nesting limit while accepting a nearby valid expression", async () => {
    const nested = (count: number) => `${"$not(".repeat(count)}true${")".repeat(count)}`;
    await expect(compile(nested(127)).evaluate({})).resolves.toBe(false);
    expect(() => compile(`${nested(127)} + 1`)).not.toThrow();
    expect(() => compile(nested(128))).toThrow("JSONata expression exceeds the maximum AST depth");
  });

  test("exposes only real bare call names and source positions", () => {
    expect(findUnboundFunctionCalls("$sum([1]) + total(items) + $f(1)")).toEqual([
      { name: "total", position: 17, suggestion: "$total" },
    ]);
    expect(findUnboundFunctionCalls("$map([1], function($value) { $value + 1 })")).toEqual([]);
    expect(findUnboundFunctionCalls("outer.inner()")).toEqual([
      { name: "inner", position: 11, suggestion: "$inner" },
    ]);
    expect(findUnboundFunctionCalls("[outer(), { 'again': outer() }]")).toEqual([
      { name: "outer", position: 6, suggestion: "$outer" },
      { name: "outer", position: 26, suggestion: "$outer" },
    ]);
    expect(findUnboundFunctionCalls("foo(?)")).toEqual([]);
    expect(findUnboundFunctionCalls("$foo()")).toEqual([]);
    expect(findUnboundFunctionCalls("a.b()")).toEqual([
      { name: "b", position: 3, suggestion: "$b" },
    ]);
    expect(findUnboundFunctionCalls("foo^(bar)()")).toEqual([]);
  });

  test("preserves every published JavaScript-to-JSONata suggestion verbatim", () => {
    expect(JSONATA_FUNCTION_SUGGESTIONS).toEqual({
      indexOf:
        "`($arr#$i[$ = value].$i)[0]` — bind the array with `:=` first; `#$i` exposes the index",
      findIndex: "`($arr#$i[<condition>].$i)[0]`",
      includes: "`value in $arr`",
      find: "`$filter($arr, function($v) { <condition> })[0]`",
      length: "`$count($arr)` for arrays (`$length` is string length only)",
      toUpperCase: "`$uppercase(str)`",
      toFixed: "`$round(num, decimals)`",
      slice: "`$arr[[0..n-1]]` (range predicate)",
      parseFloat: "`$number(str)`",
      concat: "`$append($a, $b)`",
      push: "`$append($arr, value)`",
    });
  });

  test("finds unknown calls through valid nested arrays while respecting a bound local", () => {
    expect(
      findUnknownFunctionCalls(
        "[$missing(1), { 'nested': $missing(2) }, ($local := function($x) { $x }; $local(3))]",
      ),
    ).toEqual([
      { name: "missing", position: 9, suggestion: null },
      { name: "missing", position: 34, suggestion: null },
    ]);
  });

  test("keeps traversal order through nested array, object, lambda, and predicate AST collections", () => {
    expect(
      findUnknownFunctionCalls(
        "$filter([1], function($value) { [$inside($value), { 'next': $again($value) }][$value = 1] })",
      ).map((finding) => finding.name),
    ).toEqual(["inside", "again"]);
    expect(
      findUnboundFunctionCalls("[first(), { 'next': second() }][true]").map(
        (finding) => finding.name,
      ),
    ).toEqual(["first", "second"]);
  });

  test("does not treat variables in ordinary binary or call argument nodes as function bindings", () => {
    expect(findUnknownFunctionCalls("$candidate + $candidate()")).toEqual([
      { name: "candidate", position: 23, suggestion: null },
    ]);
    expect(findUnknownFunctionCalls("$callback($callback)")).toEqual([
      { name: "callback", position: 9, suggestion: null },
    ]);
    expect(findUnknownFunctionCalls("foo()")).toEqual([]);
    expect(findUnknownFunctionCalls("$missing(?)")).toEqual([]);
    expect(findUnknownFunctionCalls('"foo"()')).toEqual([]);
    expect(findUnknownFunctionCalls("*()")).toEqual([]);
  });

  test("extracts dependency namespaces in first-seen order and only scopes the step id", () => {
    expect(
      parseDeps(
        "$input.order.id & $scope.fetch.data.name & $cred.crm.token & $connector.api.base & $env.REGION & $scope.fetch.other & $input.order.id",
      ),
    ).toEqual({
      inputs: ["order.id"],
      steps: ["fetch"],
      creds: ["crm.token"],
      connectors: ["api.base"],
      env: ["REGION"],
    });
  });

  test("formats structured locations, primitives, and circular messages without leaking unformatted values", () => {
    const located = formatError(
      { message: "bad token", position: 2, lineNumber: 3, column: 4, token: ")" },
      "a()",
    );
    expect(located).toBeInstanceOf(JSONataError);
    expect(located.name).toBe("JSONataError");
    expect(located.source).toBe("a()");
    expect(located.position).toBe(2);
    expect(located.lineNumber).toBe(3);
    expect(located.column).toBe(4);
    expect(located.token).toBe(")");
    expect(located.message).toBe("JSONata error at L3:4: bad token\n  a(█)");

    expect(formatError({ message: 0 }, "x").message).toContain(": 0");
    expect(formatError({ message: false }, "x").message).toContain(": false");
    expect(formatError({ message: Number.NaN }, "x").message).toContain(": NaN");
    expect(formatError({ message: Number.POSITIVE_INFINITY }, "x").message).toContain(": Infinity");
    expect(formatError(undefined, "x").message).toBe("JSONata error: JSONata error");
    expect(formatError({ message: "" }, "x").message).toBe('JSONata error: ""');
    expect(formatError({ message: null }, "x").message).toBe("JSONata error: JSONata error");
    expect(formatError({ message: {} }, "x").message).toBe("JSONata error: JSONata error");
    expect(formatError({ message: ["one", 2] }, "x").message).toBe('JSONata error: ["one",2]');
    const circular: { message?: unknown } = {};
    circular.message = circular;
    expect(formatError(circular, "x").message).toBe("JSONata error: JSONata error");
  });

  test("returns an AST only for compilable sources", () => {
    expect(extractAst("$sum([1,2])")).toMatchObject({ type: "function" });
    expect(extractAst("$random()")).toBeNull();
    expect(extractAst("(")).toBeNull();
  });

  test("uses JSONata's mandatory public ast() API at every contract consumer", () => {
    expect(compile("$sum([1,2])").ast()).toMatchObject({ type: "function" });
    expect(findUnboundFunctionCalls("bare() ")).toEqual([
      { name: "bare", position: 4, suggestion: "$bare" },
    ]);
    expect(extractAst("$count([1])")).toMatchObject({ type: "function" });
  });
});
