import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "../../../../..");
const readRepoFile = (relativePath: string) => readFileSync(join(repoRoot, relativePath), "utf8");

const renewLabels = [
  ...readRepoFile("apps/cockpit/src/lib/i18n/setup.ts").matchAll(/"rules\.renew": "([^"]+)"/g),
].map((match) => match[1] ?? "");
const [englishRenewLabel = "", germanRenewLabel = ""] = renewLabels;

const guides = [
  {
    locale: "en",
    text: readRepoFile("apps/engine/src/http/reference/when-subkit-asks.en.md"),
    renewLabel: englishRenewLabel,
  },
  {
    locale: "de",
    text: readRepoFile("apps/engine/src/http/reference/when-subkit-asks.de.md"),
    renewLabel: germanRenewLabel,
  },
];

const bulletLines = (text: string) => text.split("\n").filter((line) => line.startsWith("- "));

describe("when-subkit-asks guide on renewing rules", () => {
  test("the cockpit catalog has an English and a German renew label", () => {
    expect(renewLabels).toHaveLength(2);
    expect(englishRenewLabel).toBe("Renew");
    expect(germanRenewLabel.length).toBeGreaterThan(0);
  });

  test("the English guide does not claim renewing is unavailable on the Rules page", () => {
    expect(guides[0]?.text).not.toContain("not possible on the Rules page");
  });

  for (const { locale, text, renewLabel } of guides) {
    test(`${locale}: no limitation bullet sends renewing to the route`, () => {
      expect(
        bulletLines(text).filter((line) => line.includes("/v1/approval-rules/{id}/renew")),
      ).toEqual([]);
    });

    test(`${locale}: a bullet names the cockpit renew button and the audit action`, () => {
      const renewBullet = bulletLines(text).find((line) => line.includes(`**${renewLabel}**`));
      expect(renewBullet).toBeDefined();
      expect(renewBullet).toContain("tool_approval_rule.renewed");
      expect(renewBullet).toContain("90");
    });
  }
});
