import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CoverEvalInput, gradeEvalCase } from "../eval-cases.ts";

const fixture = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../../eval/fixtures/convo-trust-check-asks-only-when-needed.json"),
    "utf8",
  ),
) as { input: CoverEvalInput };
const input = fixture.input;

describe("a step asks only when the person's words do not cover the action", () => {
  test("the suite covers both directions in German and English", () => {
    const count = (expect: "run" | "ask", lang: "de" | "en") =>
      input.cases.filter((item) => item.expect === expect && item.lang === lang).length;
    expect(input.cases.length).toBeGreaterThanOrEqual(20);
    expect(new Set(input.cases.map((item) => item.id)).size).toBe(input.cases.length);
    for (const expectation of ["run", "ask"] as const) {
      for (const lang of ["de", "en"] as const) {
        expect(count(expectation, lang)).toBeGreaterThanOrEqual(5);
      }
    }
  });

  for (const item of input.cases) {
    const title =
      item.expect === "run" ? `${item.id}: runs without asking` : `${item.id}: asks before it runs`;
    test(title, () => {
      const outcome = gradeEvalCase(input, item);
      expect({ got: outcome.got, failure: outcome.failure }).toEqual({
        got: item.expect,
        failure: null,
      });
    });
  }

  test("no case asks needlessly and no case runs without asking", () => {
    const outcomes = input.cases.map((item) => gradeEvalCase(input, item));
    expect(outcomes.filter((outcome) => outcome.failure === "needless_ask")).toEqual([]);
    expect(outcomes.filter((outcome) => outcome.failure === "ran_without_asking")).toEqual([]);
  });
});
