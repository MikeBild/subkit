import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { germanTextLines } from "../audit/german-text.ts";

const repoRoot = join(import.meta.dir, "../../../..");
const readRepoFile = (path: string) => readFileSync(join(repoRoot, path), "utf8");

const guideSection = (locale: "en" | "de") => {
  const path = (language: string) =>
    `apps/engine/src/http/reference/maintain-sources-skills-and-files.${language}.md`;
  const index = readRepoFile(path("en"))
    .split("\n### ")
    .findIndex((section) => section.startsWith("Find conversations about a source or a skill\n"));
  expect(index).toBeGreaterThan(0);
  const section = readRepoFile(path(locale)).split("\n### ")[index];
  expect(section).toBeDefined();
  return section!;
};

const cockpitLabels = (key: string) =>
  [
    ...readRepoFile("apps/cockpit/src/lib/i18n/kn.ts").matchAll(
      new RegExp(`"${key.replaceAll(".", "\\.")}": "([^"]+)"`, "g"),
    ),
  ].map((match) => match[1]);

describe("reference guide: conversations about a source or a skill (#559)", () => {
  for (const [index, locale] of (["en", "de"] as const).entries()) {
    test(`${locale}: names only controls the Usage tab renders`, () => {
      const section = guideSection(locale);
      const usage = cockpitLabels("kn.tab.usage")[index];
      const chat = cockpitLabels("kn.use.chat")[index];
      expect(section).toContain(`**${usage}**`);
      expect(section).toContain(`**${chat}**`);
      const controls = [...section.matchAll(/\*\*([^*]+)\*\*/g)].map((match) => match[1]);
      expect(controls.every((label) => label === usage || label === chat)).toBe(true);
    });
  }
});

test("the reference regression keeps localized text in locale homes", () => {
  expect(germanTextLines(readFileSync(import.meta.path, "utf8"))).toEqual([]);
});
