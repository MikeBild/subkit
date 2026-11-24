import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../../..");
const readRepoFile = (path: string) => readFileSync(join(repoRoot, path), "utf8");

const guideSection = (locale: "en" | "de", heading: string) => {
  const guide = readRepoFile(
    `apps/engine/src/http/reference/maintain-sources-skills-and-files.${locale}.md`,
  );
  const start = guide.indexOf(`### ${heading}`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = guide.indexOf("\n### ", start + 4);
  return guide.slice(start, end === -1 ? undefined : end);
};

const cockpitLabels = (key: string) =>
  [
    ...readRepoFile("apps/cockpit/src/lib/i18n/kn.ts").matchAll(
      new RegExp(`"${key.replaceAll(".", "\\.")}": "([^"]+)"`, "g"),
    ),
  ].map((match) => match[1]);

describe("reference guide: conversations about a source or a skill (#559)", () => {
  const cases = [
    {
      locale: "en",
      heading: "Find conversations about a source or a skill",
      missing: ["Conversations about this", "Ask in chat"],
      index: 0,
    },
    {
      locale: "de",
      heading: "Unterhaltungen zu einer Quelle oder einem Skill finden",
      missing: ["Unterhaltungen dazu", "Im Chat fragen"],
      index: 1,
    },
  ] as const;

  for (const { locale, heading, missing, index } of cases) {
    test(`${locale}: names only controls the Usage tab renders`, () => {
      const section = guideSection(locale, heading);
      for (const phrase of missing) expect(section).not.toContain(phrase);
      expect(section).toContain(`**${cockpitLabels("kn.tab.usage")[index]}**`);
      expect(section).toContain(`**${cockpitLabels("kn.use.chat")[index]}**`);
    });
  }
});
