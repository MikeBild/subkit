import { expect, test } from "bun:test";
import fc from "fast-check";
import { walkStrings } from "./walk-strings.ts";

test("string traversal preserves paths and insertion order across nested structures", () => {
  const seen: Array<[string, string]> = [];
  const input = Object.freeze({
    first: "a",
    nested: Object.freeze(["b", { last: "c" }, null, 3, false]),
    empty: {},
    nil: undefined,
  });
  walkStrings(input, (text, path) => seen.push([text, path]), "root");
  expect(seen).toEqual([
    ["a", "root.first"],
    ["b", "root.nested.0"],
    ["c", "root.nested.1.last"],
  ]);
  expect(input.first).toBe("a");
});

test("root strings retain an empty default path and nonstrings emit no visit", () => {
  const seen: Array<[string, string]> = [];
  walkStrings("", (text, path) => seen.push([text, path]));
  expect(seen).toEqual([["", ""]]);
  for (const input of [undefined, null, 0, false, [], {}, Symbol("value")])
    walkStrings(input, () => {
      throw new Error("unexpected visit");
    });
});

test("arrays visit indexed entries only and functions remain non-container values", () => {
  const seen: Array<[string, string]> = [];
  const values = Object.assign(["indexed"], { annotation: "not an array entry" });
  const callable = Object.assign(() => {}, { annotation: "not an object container" });
  walkStrings(values, (text, path) => seen.push([text, path]), "items");
  walkStrings(callable, (text, path) => seen.push([text, path]), "function");
  expect(seen).toEqual([["indexed", "items.0"]]);
});

test("flat string array traversal neither drops nor changes values", () => {
  fc.assert(
    fc.property(fc.array(fc.string(), { maxLength: 30 }), (values) => {
      const seen: Array<[string, string]> = [];
      walkStrings(Object.freeze([...values]), (text, path) => seen.push([text, path]));
      expect(seen).toEqual(values.map((value, index) => [value, `.${index}`]));
    }),
    { seed: 20261109, numRuns: 100 },
  );
});
