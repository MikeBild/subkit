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
  const source = readFileSync(
    join(REPO, "apps", "cockpit", "src", "components", "family-ui.tsx"),
    "utf8",
  );
  const declared = source.match(/FAMILY_UI_VERSION\s*=\s*"([^"]+)"/);
  expect(declared?.[1]).toBeDefined();
  expect(declared?.[1]).toBe(familyUi.familyVersion);
});

test("the two version numbers are not required to match", () => {
  expect(familyUi.familyVersion).not.toBe(OPERATIONAL_SCHEMA_VERSION);
});
