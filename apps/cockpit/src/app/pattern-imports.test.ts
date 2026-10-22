import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..");

type Rule = "ui-import" | "heading" | "pre" | "dl" | "sheet-content" | "max-w";

const RULES: Record<Rule, RegExp> = {
  "ui-import": /from\s+["']@\/components\/ui\//,
  heading: /<h[123][\s>]/,
  pre: /<pre[\s>]/,
  dl: /<dl[\s>]/,
  "sheet-content": /\bSheetContent\b/,
  "max-w": /\bmax-w-/,
};

function scopedFiles(): string[] {
  const pages = readdirSync(join(SRC, "pages"), { recursive: true, encoding: "utf8" })
    .filter((file) => file.endsWith(".tsx") && !file.includes(".test."))
    .map((file) => join(SRC, "pages", file));
  const cockpit = readdirSync(join(SRC, "components/cockpit"), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
    .filter((entry) => !entry.name.includes(".test."))
    .map((entry) => join(SRC, "components/cockpit", entry.name));
  return [...pages, ...cockpit].sort();
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
  "components/cockpit/automation-grant.tsx": ["ui-import"],
  "components/cockpit/connector-credentials.tsx": ["ui-import"],
  "components/cockpit/decision-card.tsx": ["ui-import", "heading", "max-w"],
  "components/cockpit/diff-card.tsx": ["ui-import", "pre"],
  "components/cockpit/grant-notices.tsx": ["ui-import"],
  "components/cockpit/grant-workflow-authority.tsx": ["ui-import"],
  "components/cockpit/icon-button.tsx": ["ui-import"],
  "components/cockpit/inbound-hook-review-card.tsx": ["ui-import", "heading"],
  "components/cockpit/run-workflow-dialog.tsx": ["ui-import"],
  "components/cockpit/schedule-review-card.tsx": ["ui-import", "heading"],
  "components/cockpit/table-columns.tsx": ["ui-import", "max-w"],
};

const CEILING = 16;

describe("pages compose the pattern set", () => {
  test("no file breaks a rule it is not listed for", () => {
    const found = violations();
    const unlisted = Object.entries(found).flatMap(([file, rules]) =>
      rules.filter((rule) => !ALLOWED[file]?.includes(rule)).map((rule) => `${file}: ${rule}`),
    );
    expect(unlisted, "use the pattern from components/cockpit/patterns instead").toEqual([]);
  });

  test("every listed violation still exists — a fixed file leaves the list", () => {
    const found = violations();
    const stale = Object.entries(ALLOWED).flatMap(([file, rules]) =>
      rules.filter((rule) => !found[file]?.includes(rule)).map((rule) => `${file}: ${rule}`),
    );
    expect(stale, "remove these entries from ALLOWED").toEqual([]);
  });

  test("the list only shrinks", () => {
    expect(Object.keys(ALLOWED).length).toBeLessThanOrEqual(CEILING);
  });

  test("the rules reach the files they are meant for", () => {
    const files = scopedFiles().map((file) => relative(SRC, file));
    expect(files).toContain("pages/catalog.tsx");
    expect(files).toContain("components/cockpit/workflow-page.tsx");
    expect(files.some((file) => file.includes("/patterns/"))).toBe(false);
  });
});
