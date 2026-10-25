import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { collectFamilyUiDrift } from "./check-family-ui-drift.ts";

const root = join(import.meta.dir, "..");
const spec = () => JSON.parse(readFileSync(join(root, "FAMILY-UI.json"), "utf8"));
const konvention = readFileSync(join(root, "COCKPIT-KONVENTION.md"), "utf8");

describe("the family UI drift check", () => {
  test("FAMILY-UI.json and the convention match the Cockpit code", () => {
    expect(collectFamilyUiDrift(spec(), { "COCKPIT-KONVENTION.md": konvention })).toEqual([]);
  });

  test("a changed geometry value is reported", () => {
    const changed = spec();
    changed.geometry.headerPx = 56;
    const problems = collectFamilyUiDrift(changed, { "COCKPIT-KONVENTION.md": konvention });
    expect(problems.join("\n")).toContain("geometry.headerPx");
  });

  test("a changed typography value is reported", () => {
    const changed = spec();
    changed.typography.articleBody = "14px/20px 400";
    const problems = collectFamilyUiDrift(changed, { "COCKPIT-KONVENTION.md": konvention });
    expect(problems.join("\n")).toContain("typography.articleBody");
  });

  test("a changed navigation group is reported", () => {
    const changed = spec();
    changed.navigation.groups = ["work", ...changed.navigation.groups];
    const problems = collectFamilyUiDrift(changed, { "COCKPIT-KONVENTION.md": konvention });
    expect(problems.join("\n")).toContain("navigation.groups");
  });

  test("a changed navigation label is reported", () => {
    const changed = spec();
    changed.navigation.labels.de.installation = "Verwaltung";
    const problems = collectFamilyUiDrift(changed, { "COCKPIT-KONVENTION.md": konvention });
    expect(problems.join("\n")).toContain("navigation.labels.de.installation");
  });

  test("a value declared without a code check is reported", () => {
    const changed = spec();
    changed.geometry.unchecked = 1;
    const problems = collectFamilyUiDrift(changed, { "COCKPIT-KONVENTION.md": konvention });
    expect(problems.join("\n")).toContain("geometry.unchecked");
  });

  test("a convention that states other widths or the old group name is reported", () => {
    const stale = konvention.replaceAll("1760px", "1280px");
    expect(collectFamilyUiDrift(spec(), { "COCKPIT-KONVENTION.md": stale }).join("\n")).toContain(
      "1760px",
    );
    const renamed = `${konvention}\nDie Gruppe **Verwaltung** bleibt.`;
    expect(collectFamilyUiDrift(spec(), { "COCKPIT-KONVENTION.md": renamed }).join("\n")).toContain(
      "Verwaltung",
    );
  });

  test("a design system document that states other widths is reported", () => {
    const problems = collectFamilyUiDrift(spec(), {
      "COCKPIT-KONVENTION.md": konvention,
      ".superdesign/design-system.md": "wide column max 1280px",
    });
    expect(problems.join("\n")).toContain(".superdesign/design-system.md");
  });
});
