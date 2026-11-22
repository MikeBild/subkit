import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const dockerfile = readFileSync(join(ROOT, "Dockerfile"), "utf8");
const workflow = Bun.YAML.parse(
  readFileSync(join(ROOT, ".github/workflows/release.yml"), "utf8"),
) as {
  jobs: {
    release: {
      steps: Array<{ name?: string; run?: string; with?: Record<string, unknown> }>;
    };
  };
};
const steps = workflow.jobs.release.steps;

function stepIndex(predicate: (step: (typeof steps)[number]) => boolean): number {
  const index = steps.findIndex(predicate);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

describe("macOS subkit signing in the release chain", () => {
  test("the image signs darwin binaries with the pinned rcodesign before staging them", () => {
    const lines = dockerfile.split("\n");
    const stage = lines.findIndex((line) => /^FROM builder AS generated-cli$/.test(line));
    const nextStage = lines.findIndex((line, i) => i > stage && line.startsWith("FROM "));
    const install = lines.findIndex((line) => line.includes("scripts/install-rcodesign.ts"));
    const staging = lines.findIndex((line) => line.includes("scripts/stage-cli-binaries.ts"));
    expect(stage).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(stage);
    expect(staging).toBeGreaterThan(install);
    expect(staging).toBeLessThan(nextStage);
    expect(dockerfile).toMatch(/^ARG CLI_BINARIES_SOURCE=generated-cli$/m);
  });

  test("the release build keeps the generated binaries source", () => {
    const build = steps.find((step) => step.name === "Build image");
    expect(String(build?.with?.["build-args"] ?? "")).not.toContain("CLI_BINARIES_SOURCE");
  });

  test("checksums cover the extracted signed binaries before the Ed25519 signature", () => {
    const extract = stepIndex((step) => step.name === "Extract release binaries from the image");
    const stageEvidence = stepIndex(
      (step) => step.name === "Stage verified quality evidence in release assets",
    );
    const checksums = stepIndex((step) => step.name === "Write release checksums");
    const sign = stepIndex((step) => step.name === "Sign SHA256SUMS");
    const extractRun = steps[extract]?.run ?? "";
    const stageRun = steps[stageEvidence]?.run ?? "";
    const checksumsRun = steps[checksums]?.run ?? "";
    expect(extractRun.indexOf("/usr/local/share/subkit/binaries/.")).toBeGreaterThanOrEqual(0);
    expect(stageEvidence).toBeGreaterThan(extract);
    expect(checksums).toBeGreaterThan(stageEvidence);
    expect(sign).toBeGreaterThan(checksums);
    expect(stageRun).toContain('test ! -e "assets/$asset"');
    expect(stageRun).toContain('cp "$QUALITY_ASSETS_DIR/$asset" "assets/$asset"');
    expect(checksumsRun).toMatch(/sha256sum[^\n]*subkit-darwin-arm64/);
    expect(checksumsRun).toContain("quality-evidence.tar.gz quality-evidence.json");
    const verifyMacos = extractRun.indexOf(
      "bun scripts/verify-macos-binaries.ts assets/subkit-darwin-arm64",
    );
    expect(verifyMacos).toBeGreaterThan(extractRun.indexOf("/usr/local/share/subkit/binaries/."));
    for (const step of steps.slice(extract + 1)) {
      expect(step.run ?? "").not.toMatch(
        /(codesign|rcodesign)\b|>\s*assets\/subkit-darwin|cp [^\n]*assets\/subkit-darwin/,
      );
    }
  });
});
