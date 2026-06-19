// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal `${...}` placeholder tokens are part of the tested grammar.
// levenshtein — small pure helpers used in two places:
// `validateStepReferences` (authoring-time) and `loop.ts` /
// `branch.ts` (runtime) both surface "did you mean" suggestions
// with the same vocabulary, so the helpers are unit-tested once.

import { describe, expect, test } from "bun:test";
import { extractStepIdReferences, levenshtein, suggestClosest } from "../levenshtein.ts";

describe("levenshtein", () => {
  test("identical strings → 0", () => {
    expect(levenshtein("abc", "abc")).toBe(0);
  });

  test("empty input handled", () => {
    expect(levenshtein("", "abc")).toBe(3);
    expect(levenshtein("abc", "")).toBe(3);
  });

  test("typical edit distances", () => {
    expect(levenshtein("kitten", "sitting")).toBe(3);
    expect(levenshtein("custumer", "customer")).toBe(1);
  });
});

describe("suggestClosest", () => {
  test("returns sorted candidates within the threshold", () => {
    const matches = suggestClosest("custumer", ["customer", "customers", "order"]);
    expect(matches[0]).toBe("customer");
    expect(matches).toContain("customers");
    expect(matches).not.toContain("order");
  });

  test("empty result when no candidate is close enough", () => {
    expect(suggestClosest("apple", ["banana", "carrot"])).toEqual([]);
  });

  test("excludes the exact match", () => {
    expect(suggestClosest("foo", ["foo", "fop"])).toEqual(["fop"]);
  });

  test("limit caps the result set", () => {
    const matches = suggestClosest("aa", ["ab", "ac", "ad", "ae"], 2);
    expect(matches.length).toBe(2);
  });
});

describe("extractStepIdReferences", () => {
  test("recognises $scope.<id>", () => {
    expect(extractStepIdReferences("$scope.fetch.data")).toEqual(["fetch"]);
  });

  test("recognises $steps.<id>", () => {
    expect(extractStepIdReferences("$steps.fetch.items.id")).toEqual(["fetch"]);
  });

  test("recognises ${scope.<id>...} placeholder", () => {
    expect(extractStepIdReferences("hello ${scope.fetch.data} world")).toEqual(["fetch"]);
  });

  test("dedupes across multiple references", () => {
    expect(extractStepIdReferences("$scope.a.x + $steps.a.y + $scope.b.z")).toEqual(["a", "b"]);
  });

  test("ignores bare identifiers (no $scope/$steps/${scope})", () => {
    expect(extractStepIdReferences("a.b.c + foo")).toEqual([]);
  });

  test("preserves source order across all three patterns", () => {
    expect(
      extractStepIdReferences(
        "{ id: $scope.first.id, name: $steps.second.name, ext: ${scope.third.value} }",
      ),
    ).toEqual(["first", "second", "third"]);
  });
});
