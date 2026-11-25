import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Locale, t } from "./i18n.ts";

describe("desktop guide on refused invitations", () => {
  const guideOf = (locale: Locale) =>
    readFileSync(
      join(import.meta.dir, `../../../engine/src/http/reference/subkit-desktop.${locale}.md`),
      "utf8",
    );
  const rowsWith = (guide: string, text: string) =>
    guide.split("\n").filter((line) => line.startsWith("|") && line.includes(text));

  for (const locale of ["en", "de"] as const) {
    test(`${locale}: the same next step as the app for each refusal`, () => {
      const guide = guideOf(locale);
      for (const [title, body] of [
        ["invite.used", "invite.signInInstead"],
        ["invite.expired", "invite.askNew"],
      ] as const) {
        const rows = rowsWith(guide, t(locale, title));
        expect(rows).toHaveLength(1);
        expect(rows[0]).toContain(t(locale, body));
      }
      expect(rowsWith(guide, t(locale, "invite.signInInstead"))).toHaveLength(1);
    });
  }
});
