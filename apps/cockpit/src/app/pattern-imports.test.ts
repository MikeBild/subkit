import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..");

type Rule = "heading" | "pre" | "dl" | "sheet-content" | "max-w";

const RULES: Record<Rule, RegExp> = {
  heading: /<h[123][\s>]/,
  pre: /<pre[\s>]/,
  dl: /<dl[\s>]/,
  "sheet-content": /\bSheetContent\b/,
  "max-w": /\bmax-w-/,
};

function scopedFiles(): string[] {
  const pages = readdirSync(join(SRC, "pages"), { recursive: true, encoding: "utf8" })
    .filter(
      (file) =>
        file.endsWith(".tsx") && !file.includes(".test.") && !file.endsWith("-fixtures.tsx"),
    )
    .map((file) => join(SRC, "pages", file));
  const features = readdirSync(join(SRC, "features"), { recursive: true, encoding: "utf8" })
    .filter(
      (file) =>
        file.endsWith(".tsx") && !file.includes(".test.") && !file.endsWith("-fixtures.tsx"),
    )
    .map((file) => join(SRC, "features", file));
  const cockpit = readdirSync(join(SRC, "components/cockpit"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
    .filter((entry) => !entry.name.includes(".test.") && !entry.name.endsWith("-fixtures.tsx"))
    .map((entry) => join(SRC, "components/cockpit", entry.name));
  return [...pages, ...features, ...cockpit].sort();
}

function violations(): Record<string, Rule[]> {
  const found: Record<string, Rule[]> = {};
  for (const file of scopedFiles()) {
    const source = readFileSync(file, "utf8");
    const broken = (Object.keys(RULES) as Rule[]).filter((rule) => RULES[rule].test(source));
    if (broken.length > 0) found[relative(SRC, file)] = broken;
  }
  return found;
}

const ALLOWED: Record<string, readonly Rule[]> = {
  "features/feedback/feedback-dialog.tsx": ["max-w"],
  "features/decisions/ui/decision-card.tsx": ["heading", "max-w"],
  "features/workflows/ui/diff-card.tsx": ["pre"],
  "features/decisions/ui/inbound-hook-review-card.tsx": ["heading"],
  "features/workflows/ui/schedule-review-card.tsx": ["heading"],
  "components/cockpit/table-columns.tsx": ["max-w"],
};

const CEILING = 6;

function listed(file: string, rule: Rule): boolean {
  return ALLOWED[file]?.includes(rule) ?? false;
}

describe("pages compose the pattern set", () => {
  test("no file breaks a rule it is not listed for", () => {
    const found = violations();
    const unlisted = Object.entries(found).flatMap(([file, rules]) =>
      rules.filter((rule) => !listed(file, rule)).map((rule) => `${file}: ${rule}`),
    );
    expect(unlisted, "use the pattern from components/cockpit/patterns instead").toEqual([]);
  });

  test("every listed violation still exists — a fixed file leaves the list", () => {
    const found = violations();
    const stale = [
      ...Object.entries(ALLOWED).flatMap(([file, rules]) =>
        rules.filter((rule) => !found[file]?.includes(rule)).map((rule) => `${file}: ${rule}`),
      ),
    ];
    expect(stale, "remove these entries from ALLOWED").toEqual([]);
  });

  test("the lists only shrink", () => {
    expect(Object.keys(ALLOWED).length).toBeLessThanOrEqual(CEILING);
  });

  test("the rules reach the files they are meant for", () => {
    const files = scopedFiles().map((file) => relative(SRC, file));
    expect(files).toContain("pages/catalog.tsx");
    expect(files).toContain("features/workflows/ui/workflow-page.tsx");
    expect(files.some((file) => file.includes("/patterns/"))).toBe(false);
  });
});
