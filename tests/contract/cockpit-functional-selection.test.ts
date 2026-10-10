import { describe, expect, test } from "bun:test";
import { selectFunctionalJourneys } from "../../scripts/lib/cockpit-functional-selection.mjs";

const journeys = [["approval"], ["pagination"], ["session"]];

describe("cockpit functional gate selection", () => {
  test("official invocation includes every journey", () => {
    expect(selectFunctionalJourneys(journeys, [], {})).toEqual({
      selected: journeys,
      partial: false,
    });
  });

  test("inherited filters cannot reduce official release coverage", () => {
    for (const value of ["", "approval", "unknown"]) {
      expect(() =>
        selectFunctionalJourneys(journeys, [], { COCKPIT_FUNCTIONAL_JOURNEYS: value }),
      ).toThrow("is not allowed");
    }
  });

  test("explicit iteration is marked partial and validates each requested journey", () => {
    expect(selectFunctionalJourneys(journeys, ["--journey", "session"], {})).toEqual({
      selected: [["session"]],
      partial: true,
    });
    for (const args of [["--journey"], ["--skip"], ["--journey", "unknown"]]) {
      expect(() => selectFunctionalJourneys(journeys, args, {})).toThrow();
    }
  });
});
