import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..");

type Rule = "ui-import" | "ui-direct" | "heading" | "pre" | "dl" | "sheet-content" | "max-w";

const RULES: Record<Rule, RegExp> = {
  "ui-import": /from\s+["']@\/components\/ui\//,
  "ui-direct": /from\s+["']@ui\/components\/ui\//,
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
  "components/cockpit/automation-grant.tsx": ["ui-import"],
  "components/cockpit/decision-card.tsx": ["ui-import", "heading", "max-w"],
  "components/cockpit/diff-card.tsx": ["ui-import", "pre"],
  "components/cockpit/grant-notices.tsx": ["ui-import"],
  "components/cockpit/grant-environment.tsx": ["ui-import"],
  "components/cockpit/grant-workflow-authority.tsx": ["ui-import"],
  "components/cockpit/icon-button.tsx": ["ui-import"],
  "components/cockpit/inbound-hook-review-card.tsx": ["ui-import", "heading"],
  "components/cockpit/run-workflow-dialog.tsx": ["ui-import"],
  "components/cockpit/schedule-review-card.tsx": ["ui-import", "heading"],
  "components/cockpit/table-columns.tsx": ["ui-import", "max-w"],
};

const DIRECT_UI_DEBT: readonly string[] = [
  "components/cockpit/grant-environment.tsx",
  "features/knowledge/files.tsx",
  "features/knowledge/inbox.tsx",
  "features/knowledge/shell.tsx",
  "features/knowledge/skills.tsx",
  "features/knowledge/sources.tsx",
  "features/operations/approval-limits.tsx",
  "features/usage/usage-page.tsx",
];

const CEILING = 12;
const DIRECT_UI_CEILING = 8;

function listed(file: string, rule: Rule): boolean {
  if (rule === "ui-direct") return DIRECT_UI_DEBT.includes(file);
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
      ...DIRECT_UI_DEBT.filter((file) => !found[file]?.includes("ui-direct")).map(
        (file) => `${file}: ui-direct`,
      ),
    ];
    expect(stale, "remove these entries from ALLOWED or DIRECT_UI_DEBT").toEqual([]);
  });

  test("the lists only shrink", () => {
    expect(Object.keys(ALLOWED).length).toBeLessThanOrEqual(CEILING);
    expect(DIRECT_UI_DEBT.length).toBeLessThanOrEqual(DIRECT_UI_CEILING);
  });

  test("the rules reach the files they are meant for", () => {
    const files = scopedFiles().map((file) => relative(SRC, file));
    expect(files).toContain("pages/catalog.tsx");
    expect(files).toContain("components/cockpit/workflow-page.tsx");
    expect(files.some((file) => file.includes("/patterns/"))).toBe(false);
  });
});
