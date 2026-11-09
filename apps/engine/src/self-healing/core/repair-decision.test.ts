import { expect, test } from "bun:test";
import fc from "fast-check";
import { decideExistingRepair } from "./repair-decision.ts";

test("applied proactive deduplicates while reactive reproposes", () => {
  expect(decideExistingRepair({ status: "applied", source: "proactive_scheduler" })).toEqual({
    kind: "return_applied",
  });
  expect(decideExistingRepair({ status: "applied", source: "reactive" })).toEqual({
    kind: "repropose",
  });
});

test("non-applied candidates refresh", () => {
  fc.assert(
    fc.property(fc.constantFrom("proposed", "rejected", "superseded", "inapplicable"), (status) => {
      expect(decideExistingRepair({ status, source: "proactive_scheduler" })).toEqual({
        kind: "refresh",
      });
    }),
    { seed: 20261109, numRuns: 100 },
  );
});
