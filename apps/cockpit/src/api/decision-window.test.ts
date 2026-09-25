// The overview and the decisions queue must ask about the same span of time.
//
// They did not. The overview counted failed runs over 24 hours in its own SQL,
// the queue read the digest over seven days, and the badge added the two
// categories together. The screen then said "production incidents: 0" next to
// a badge counting two failing workflows, with nothing to reconcile them.
//
// The engine owns the number. This reads it out of the engine's source rather
// than importing it, because the cockpit builds against its own tsconfig and an
// import across that boundary does not resolve — and a copied constant with a
// comment saying "keep in sync" is exactly what drifted the first time.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FAILURE_WINDOW_HOURS } from "./decisions";

test("the queue asks over the window the engine counts", () => {
  const source = readFileSync(
    join(import.meta.dir, "../../../engine/src/operator/health-digest.ts"),
    "utf8",
  );
  const declared = source.match(/DECISION_FAILURE_WINDOW_HOURS\s*=\s*(\d+)/);
  // A parse that finds nothing must fail here rather than silently assert
  // nothing: the constant being renamed is the same drift this guards against.
  expect(declared?.[1]).toBeDefined();
  expect(Number(declared?.[1])).toBe(FAILURE_WINDOW_HOURS);
});
