import { afterEach, describe, expect, test } from "bun:test";
import {
  _resetCacheForTests,
  describeUnknownFunction,
  evaluate,
  findUnboundFunctionCalls,
  findUnknownFunctionCalls,
  JSONATA_BUILTIN_FUNCTIONS,
  JSONATA_FUNCTION_SUGGESTIONS,
  JSONataError,
} from "../jsonata-engine.ts";

afterEach(() => {
  _resetCacheForTests();
});

describe("JSONATA_BUILTIN_FUNCTIONS", () => {
  test("every entry is a function the installed jsonata binds (static frame + now/millis)", async () => {
    expect(JSONATA_BUILTIN_FUNCTIONS.size).toBe(62);
    expect(JSONATA_BUILTIN_FUNCTIONS.has("now")).toBe(true);
    expect(JSONATA_BUILTIN_FUNCTIONS.has("millis")).toBe(true);
    for (const name of ["random", "shuffle", "eval"]) {
      expect(JSONATA_BUILTIN_FUNCTIONS.has(name)).toBe(false);
    }
    for (const name of JSONATA_BUILTIN_FUNCTIONS) {
      expect(await evaluate<boolean>(`$type($${name}) = "function"`, {})).toBe(true);
    }
  });

  test("a JavaScript method name is not bound by jsonata at all", async () => {
    expect(await evaluate("$type($indexOf)", {})).toBeUndefined();
    expect(JSONATA_BUILTIN_FUNCTIONS.has("indexOf")).toBe(false);
  });
});

describe("JSONATA_FUNCTION_SUGGESTIONS", () => {
  test("covers the JavaScript idioms models reach for", () => {
    expect(Object.keys(JSONATA_FUNCTION_SUGGESTIONS).sort()).toEqual(
      [
        "concat",
        "find",
        "findIndex",
        "includes",
        "indexOf",
        "length",
        "parseFloat",
        "push",
        "slice",
        "toFixed",
        "toUpperCase",
      ].sort(),
    );
  });

  test("the suggested idioms are real JSONata", async () => {
    expect(await evaluate<number>("($arr := [5, 9, 7]; ($arr#$i[$ = 9].$i)[0])", {})).toBe(1);
    expect(await evaluate<number>("($arr := [5, 9, 7]; ($arr#$i[$ > 6].$i)[0])", {})).toBe(1);
    expect(await evaluate<boolean>("9 in [5, 9, 7]", {})).toBe(true);
    expect(await evaluate<number>("$filter([5, 9, 7], function($v) { $v > 6 })[0]", {})).toBe(9);
    expect(await evaluate<number>("$count([5, 9, 7])", {})).toBe(3);
    expect(await evaluate<string>('$uppercase("ab")', {})).toBe("AB");
    expect(await evaluate<number>("$round(1.2345, 2)", {})).toBe(1.23);
    expect(await evaluate<number[]>("[5, 9, 7][[0..1]]", {})).toEqual([5, 9]);
    expect(await evaluate<number>('$number("1.5")', {})).toBe(1.5);
    expect(await evaluate<number[]>("$append([1], [2, 3])", {})).toEqual([1, 2, 3]);
  });
});

describe("findUnknownFunctionCalls", () => {
  test("flags a JavaScript method called as a JSONata function and attaches its idiom", () => {
    const findings = findUnknownFunctionCalls("$indexOf($t, 1)");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      name: "indexOf",
      suggestion: JSONATA_FUNCTION_SUGGESTIONS.indexOf,
    });
    expect(typeof findings[0]?.position).toBe("number");
  });

  test("a name without an idiom carries suggestion null", () => {
    expect(findUnknownFunctionCalls("$nope(1)")).toEqual([
      { name: "nope", position: expect.any(Number), suggestion: null },
    ]);
  });

  test("built-ins, := bindings and lambda parameters are callable", () => {
    expect(findUnknownFunctionCalls("$uppercase($trim($string(1)))")).toEqual([]);
    expect(findUnknownFunctionCalls("($f := function($x) { $x + 1 }; $f(2))")).toEqual([]);
    expect(findUnknownFunctionCalls("$map([1], function($fn) { $fn(1) })")).toEqual([]);
    expect(findUnknownFunctionCalls("[1, 2] ~> $count()")).toEqual([]);
    expect(findUnknownFunctionCalls("$now()")).toEqual([]);
  });

  test("looks inside lambda bodies and ~> chains", () => {
    expect(
      findUnknownFunctionCalls("$map($arr, function($v) { $g($v) })").map((f) => f.name),
    ).toEqual(["g"]);
    expect(findUnknownFunctionCalls("$arr ~> $nope()").map((f) => f.name)).toEqual(["nope"]);
  });

  test("reports every call site", () => {
    expect(findUnknownFunctionCalls("$nope(1) + $nope(2)")).toHaveLength(2);
  });

  test("bare calls stay with findUnboundFunctionCalls", () => {
    expect(findUnknownFunctionCalls("not(true)")).toEqual([]);
    expect(findUnboundFunctionCalls("not(true)").map((f) => f.name)).toEqual(["not"]);
  });

  test("a syntax error throws like compile does", () => {
    expect(() => findUnknownFunctionCalls("$foo(")).toThrow(JSONataError);
  });
});

describe("describeUnknownFunction", () => {
  test("names the idiom when one exists", () => {
    const [finding] = findUnknownFunctionCalls("$indexOf($t, 1)");
    expect(describeUnknownFunction(finding!)).toBe(
      `JSONata has no function \`$indexOf\`; use ${JSONATA_FUNCTION_SUGGESTIONS.indexOf}`,
    );
  });

  test("states the callable set when no idiom exists", () => {
    expect(describeUnknownFunction({ name: "nope", suggestion: null })).toBe(
      "JSONata has no function `$nope` — only JSONata built-ins and functions bound with := function(...) are callable",
    );
  });
});
