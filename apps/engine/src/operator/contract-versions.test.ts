// Two numbers, two contracts, one file that points at both.
//
// `OPERATIONAL_OVERVIEW_CONTRACT_VERSION` versions this payload. `FAMILY-UI.json`'s
// `familyVersion` versions the cross-product cockpit UI. They are independent,
// and reading them as one cost an afternoon: the engine said 2.2, the UI file
// said 2.3, and the obvious conclusion — that one of them was stale — was wrong.
//
// What IS coupled is narrower and never checked until now: `FAMILY-UI.json`
// declares which payload it renders (`apiSchemaVersion`) and which UI contract
// it describes (`familyVersion`), and the cockpit stamps that second number into
// every page. Nothing in the repo reads that file, so both could drift from the
// code they name without a single test going red.

import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { OPERATIONAL_SCHEMA_VERSION } from "./operational-overview.ts";

const REPO = join(import.meta.dir, "..", "..", "..", "..");

const familyUi = JSON.parse(readFileSync(join(REPO, "FAMILY-UI.json"), "utf8")) as {
  familyVersion: string;
  apiSchemaVersion: string;
};

test("the UI contract names the payload this engine serves", () => {
  expect(familyUi.apiSchemaVersion).toBe(OPERATIONAL_SCHEMA_VERSION);
});

test("the number the cockpit stamps is the number the UI contract declares", () => {
  // Read out of the cockpit's source rather than imported: that file is built
  // against its own tsconfig and an import across the boundary does not
  // resolve. A copied constant with "keep in sync" beside it is what drifts.
  const source = readFileSync(
    join(REPO, "apps", "cockpit", "src", "components", "family-ui.tsx"),
    "utf8",
  );
  const declared = source.match(/FAMILY_UI_VERSION\s*=\s*"([^"]+)"/);
  // A parse that finds nothing must fail here rather than silently assert
  // nothing — the constant being renamed is the drift this guards against.
  expect(declared?.[1]).toBeDefined();
  expect(declared?.[1]).toBe(familyUi.familyVersion);
});

test("the two version numbers are not required to match", () => {
  // Stated as a test so nobody "fixes" it again: the payload version and the UI
  // contract version move independently, and today they genuinely differ.
  expect(familyUi.familyVersion).not.toBe(OPERATIONAL_SCHEMA_VERSION);
});
