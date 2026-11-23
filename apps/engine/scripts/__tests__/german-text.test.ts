import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { germanTextLines, isGermanTextScope } from "../audit/german-text.ts";
import { createCache, evaluateRatchet, RATCHETS } from "../audit/ratchets.ts";

function repoWith(files: Record<string, string>): string {
  const repo = mkdtempSync(join(tmpdir(), "subkit-german-text-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  }
  execFileSync("git", ["add", "."], { cwd: repo });
  return repo;
}

function auditOf(repo: string) {
  const ratchet = RATCHETS.find((entry) => entry.id === "no_german_outside_locales");
  if (!ratchet) throw new Error("no_german_outside_locales is not registered");
  return evaluateRatchet(repo, ratchet, createCache(repo));
}

describe("no_german_outside_locales", () => {
  test("the audit fails on German text in code and passes on the locale homes", () => {
    const home = { "apps/cockpit/src/lib/i18n/overview.ts": 'export const title = "Übersicht";\n' };
    const failing = repoWith({
      ...home,
      "apps/engine/src/http/routes/page.ts": 'export const title = "Übersicht";\n',
    });
    const passing = repoWith({
      ...home,
      "apps/engine/src/http/routes/page.ts": 'export const title = "Overview";\n',
    });
    try {
      const failed = auditOf(failing);
      expect(failed.status).toBe("FAIL");
      expect(failed.message).toContain(
        "apps/engine/src/http/routes/page.ts (1 lines, not allowlisted)",
      );
      expect(failed.message).not.toContain("i18n/overview.ts");
      expect(auditOf(passing).status).toBe("PASS");
    } finally {
      rmSync(failing, { recursive: true, force: true });
      rmSync(passing, { recursive: true, force: true });
    }
  });
});

describe("germanTextLines", () => {
  test("finds German characters and German words line by line", () => {
    expect(
      germanTextLines(
        [
          'const label = "Run";',
          'const title = "Übersicht";',
          "// this does not work",
          'throw new Error("Das geht nicht");',
          'const quote = "„du“";',
          'const words = "Fehler oder Warnung";',
        ].join("\n"),
      ),
    ).toEqual([2, 4, 5, 6]);
  });

  test("ignores English text, English words that contain German ones and curly English quotes", () => {
    expect(
      germanTextLines(
        [
          'const label = "Run the undo, the kind node and nothing else";',
          "const dir = sundial(undefined);",
          "Select “Apply” to continue.",
          "café ñandú 日本語",
        ].join("\n"),
      ),
    ).toEqual([]);
  });
});

describe("isGermanTextScope", () => {
  test("scans code, docs and config outside the locale homes", () => {
    for (const path of [
      "apps/engine/src/http/routes/oauth/ui.ts",
      "apps/cockpit/src/pages/tasks-pages.test.tsx",
      "apps/engine/src/http/reference/subkit-desktop.en.md",
      ".github/ISSUE_TEMPLATE/bug.yml",
      "README.md",
      "scripts/check-docs.ts",
      "apps/cockpit/src/app/release-notes.generated.ts",
    ])
      expect(isGermanTextScope(path)).toBe(true);
  });

  test("leaves the locale homes, generated docs, third-party files and binaries alone", () => {
    for (const path of [
      "apps/cockpit/src/lib/i18n/overview.ts",
      "apps/desktop/src/shared/i18n.ts",
      "packages/ui/src/i18n/de.ts",
      "apps/engine/src/http/reference/subkit-desktop.de.md",
      "apps/engine/src/http/llms/docs.json",
      "vendor/notices/manifest.json",
      "bun.lock",
      "apps/cockpit/public/favicon.png",
    ])
      expect(isGermanTextScope(path)).toBe(false);
  });
});
