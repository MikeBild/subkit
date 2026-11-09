import { describe, expect, test } from "bun:test";
import {
  describeUnknownFunction,
  findUnknownFunctionCalls,
  JSONataError,
} from "./jsonata-contract.ts";

describe("unknown JSONata function diagnostics", () => {
  test("reports every unknown call site in source order with its source position", () => {
    expect(findUnknownFunctionCalls("$nope(1) + $nope(2)")).toEqual([
      { name: "nope", position: 5, suggestion: null },
      { name: "nope", position: 16, suggestion: null },
    ]);
  });

  test("guides a JavaScript array idiom toward its JSONata equivalent", () => {
    const findings = findUnknownFunctionCalls("$includes([1], 1)");
    expect(findings).toEqual([{ name: "includes", position: 9, suggestion: "`value in $arr`" }]);
    expect(describeUnknownFunction(findings[0]!)).toBe(
      "JSONata has no function `$includes`; use `value in $arr`",
    );
    expect(describeUnknownFunction({ name: "nope", suggestion: null })).toBe(
      "JSONata has no function `$nope` — only JSONata built-ins and functions bound with := function(...) are callable",
    );
  });

  test("accepts built-ins, explicitly bound functions and lambda parameters", () => {
    for (const source of [
      '$uppercase($trim(" a "))',
      "($f := function($x) { $x + 1 }; $f(2))",
      "$map([1], function($fn) { $fn(1) })",
      "[1, 2] ~> $count()",
      "$now()",
    ]) {
      expect(findUnknownFunctionCalls(source)).toEqual([]);
    }
  });

  test("finds nested unknown calls without treating data and bare names as function variables", () => {
    expect(findUnknownFunctionCalls("$map([1], function($v) { $missing($v) })")).toEqual([
      { name: "missing", position: 33, suggestion: null },
    ]);
    expect(findUnknownFunctionCalls('[true, null, {"x": "$nope()"}]')).toEqual([]);
    expect(findUnknownFunctionCalls("not(true)")).toEqual([]);
  });

  test("refuses malformed expressions instead of reporting an empty diagnostic", () => {
    expect(() => findUnknownFunctionCalls("$missing(")).toThrow(JSONataError);
  });
});
