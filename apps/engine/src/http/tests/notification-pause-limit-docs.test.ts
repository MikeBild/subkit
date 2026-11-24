import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PAUSE_MAX_MINUTES, planPause } from "../../notifications/notification-pause.ts";

const repoRoot = join(import.meta.dir, "../../../../..");
const readRepoFile = (relativePath: string) => readFileSync(join(repoRoot, relativePath), "utf8");

const maxPauseDays = PAUSE_MAX_MINUTES / (24 * 60);
const resumedLabels = [
  ...readRepoFile("apps/cockpit/src/lib/i18n/setup.ts").matchAll(
    /"pause\.option\.resumed": "([^"]+)"/g,
  ),
].map((match) => match[1] ?? "");

const locales = ["en", "de"] as const;
const linesWith = (text: string, needle: string) =>
  text.split("\n").filter((line) => line.includes(needle));

describe("docs on the notification pause limit", () => {
  test("an until-resumed pause has no end and no limit", () => {
    expect(
      planPause({ mode: "until_resumed" }, new Date("2026-11-21T10:00:00.000Z")),
    ).toMatchObject({
      ok: true,
      paused_until: null,
    });
    expect(resumedLabels).toHaveLength(2);
  });

  for (const [index, locale] of locales.entries()) {
    test(`${locale}: the guide ties the ${maxPauseDays}-day limit to pauses with an end`, () => {
      const guide = readRepoFile(
        `apps/engine/src/http/reference/notifications-and-quiet-hours.${locale}.md`,
      );
      const limitLines = linesWith(guide, ` ${maxPauseDays} `);
      expect(limitLines.length).toBeGreaterThan(0);
      for (const line of limitLines) expect(line).toContain(`**${resumedLabels[index]}**`);
    });

    test(`${locale}: the http reference says until_resumed has no end`, () => {
      const reference = readRepoFile(
        `apps/engine/src/http/reference/reference-pair-invites-pause.${locale}.md`,
      );
      const limitLines = linesWith(reference, "pause_too_long");
      expect(limitLines.length).toBeGreaterThan(0);
      for (const line of limitLines)
        expect(line).toMatch(/`for`.*`until`.*`until_resumed`.*`until: null`/);
    });
  }
});
