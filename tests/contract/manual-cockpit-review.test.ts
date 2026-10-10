import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
const visualEntrypoints =
  /konvention(?::check|-check\.mjs)|verify(?::cockpit-visual|-cockpit-visual\.mjs)/;

describe("manual cockpit visual acceptance", () => {
  test("automatic commands and release workflows do not invoke visual sweeps", () => {
    for (const [name, command] of Object.entries(manifest.scripts)) {
      expect(`${name} ${command}`).not.toMatch(visualEntrypoints);
    }
    for (const directory of [".githooks", ".github/workflows"]) {
      for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
        if (entry.isFile())
          expect(readFileSync(join(root, directory, entry.name), "utf8")).not.toMatch(
            visualEntrypoints,
          );
      }
    }
  });

  test("contract tests do not launch visual sweep subprocesses", () => {
    for (const filename of ["cockpit-identity.test.ts", "konvention-check-kennung.test.ts"]) {
      expect(readFileSync(join(import.meta.dir, filename), "utf8")).not.toMatch(/Bun\.spawn/);
    }
  });

  test("functional journeys have one viewport and no screenshots", () => {
    const runner = readFileSync(join(root, "scripts/verify-functional-cockpit.mjs"), "utf8");
    expect(runner).not.toContain(".screenshot(");
    expect(runner).not.toContain("assertFamilyGeometry");
    expect(runner).not.toContain("assertChatLayout");
    expect(runner).not.toContain("COCKPIT_SWEEP_");
    expect(runner).toContain("verifyChatActivation");
    expect(runner).toContain("verifyWorkflowPreview");
    expect(runner).toContain("verifyConventionJourneys");
  });

  test("release verification retains functional and generated-artifact gates", () => {
    const verify = manifest.scripts.verify;
    for (const gate of [
      "lint",
      "typecheck",
      "audit:invariants",
      "check:cockpit-drift",
      "verify:functional-cockpit",
      "test:contract",
      "test:determinism",
      "verify:ai",
      "verify:clipper-binaries",
      "test:e2e",
    ]) {
      expect(verify).toContain(`bun run ${gate}`);
    }
  });
});
