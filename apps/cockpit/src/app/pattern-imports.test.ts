// Pages and cockpit components compose the closed pattern set in
// `components/cockpit/patterns/` (spec §6) instead of reaching for raw
// primitives. Biome's path globbing cannot express "pages may not import
// `@/components/ui/*`", so this test reads the sources instead — the same
// precedent as `cockpit-ui-contract.test.ts` and `testids.test.ts`.
//
// Files that still break a rule today are listed in ALLOWED, with the exact
// rules they break. The list is a ratchet: a new violation fails, a listed
// violation that has gone fails until it is taken off the list, and the list
// may never grow past its ceiling. The page tracks shrink it to zero.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(import.meta.dir, "..");

type Rule = "ui-import" | "heading" | "pre" | "dl" | "sheet-content" | "max-w";

const RULES: Record<Rule, RegExp> = {
  // Only the patterns wrap shadcn primitives.
  "ui-import": /from\s+["']@\/components\/ui\//,
  // The one h1 is PageHeader's; section labels are Section's.
  heading: /<h[123][\s>]/,
  // CodeBlock is the only <pre>.
  pre: /<pre[\s>]/,
  // FactList is the only <dl>.
  dl: /<dl[\s>]/,
  // RecordSheet owns the two sheet widths.
  "sheet-content": /\bSheetContent\b/,
  // Page owns the page widths.
  "max-w": /\bmax-w-/,
};

/** The files the rules apply to: pages, and cockpit components outside the patterns. */
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

/**
 * Every file that still breaks a rule, and which. Only ever shrinks: migrate a
 * file onto the patterns, then delete its entry (or the rules it no longer
 * breaks) here.
 */
const ALLOWED: Record<string, readonly Rule[]> = {
  "components/cockpit/automation-grant.tsx": ["ui-import"],
  "components/cockpit/connector-credentials.tsx": ["ui-import"],
  "components/cockpit/decision-card.tsx": ["ui-import", "heading", "pre", "max-w"],
  "components/cockpit/diff-card.tsx": ["ui-import", "pre"],
  "components/cockpit/grant-boundary-panels.tsx": ["ui-import"],
  "components/cockpit/grant-notices.tsx": ["ui-import"],
  "components/cockpit/icon-button.tsx": ["ui-import"],
  "components/cockpit/inbound-hook-review-card.tsx": ["ui-import", "heading"],
  "components/cockpit/run-workflow-dialog.tsx": ["ui-import"],
  "components/cockpit/schedule-review-card.tsx": ["ui-import", "heading"],
  "components/cockpit/table-columns.tsx": ["ui-import", "max-w"],
};

/** The size of ALLOWED when it was written. Lower it as entries go; never raise it. */
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
    // A scope that matched nothing would pass every assertion above.
    const files = scopedFiles().map((file) => relative(SRC, file));
    expect(files).toContain("pages/catalog.tsx");
    expect(files).toContain("components/cockpit/workflow-page.tsx");
    expect(files.some((file) => file.includes("/patterns/"))).toBe(false);
  });
});
