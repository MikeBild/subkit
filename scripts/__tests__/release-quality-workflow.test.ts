import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../..");
const workflow = readFileSync(join(root, ".github/workflows/release.yml"), "utf8");

const position = (needle: string): number => {
  const index = workflow.indexOf(needle);
  expect(index).toBeGreaterThan(-1);
  return index;
};

test("release carries the exact same-run quality evidence into signed draft assets", () => {
  const qualityDownload = position(
    'gh run download "$GITHUB_RUN_ID" --name quality-shard-evidence',
  );
  const coverageDownload = position(
    'gh run download "$GITHUB_RUN_ID" --name coverage-floor-evidence',
  );
  const canonicalBundle = position('test -f "$quality_download/quality-bundle.json"');
  const canonicalCoverage = position('test -f "$coverage_download/latest.json"');
  const restoreClosure = position(
    'scripts/restore-release-quality-evidence.ts --commit "$RELEASE_COMMIT" --source "$quality_download"',
  );
  const verifyClosure = position(
    'scripts/verify-shard-quality-bundle.ts --commit "$RELEASE_COMMIT" --index reports/quality-export/shards/quality-bundle.json',
  );
  const packageEvidence = position("scripts/release-quality-evidence.ts package");
  const releaseNotes = position("- name: Generate release notes");
  const stagedEvidence = position("- name: Stage verified quality evidence in release assets");
  const checksums = position("quality-evidence.tar.gz quality-evidence.json > SHA256SUMS");
  const draftAssets = position("assets/quality-evidence.tar.gz assets/quality-evidence.json");

  expect(coverageDownload).toBeGreaterThan(qualityDownload);
  expect(canonicalBundle).toBeGreaterThan(coverageDownload);
  expect(canonicalCoverage).toBeGreaterThan(canonicalBundle);
  expect(restoreClosure).toBeGreaterThan(canonicalCoverage);
  expect(verifyClosure).toBeGreaterThan(restoreClosure);
  expect(packageEvidence).toBeGreaterThan(verifyClosure);
  expect(releaseNotes).toBeGreaterThan(packageEvidence);
  expect(stagedEvidence).toBeGreaterThan(releaseNotes);
  expect(checksums).toBeGreaterThan(stagedEvidence);
  expect(draftAssets).toBeGreaterThan(checksums);
  expect(workflow).toContain(
    ' --commit "$RELEASE_COMMIT" --run-id "$GITHUB_RUN_ID" --coverage-dir reports/coverage --shard-index reports/quality-export/shards/quality-bundle.json --assets-dir "$quality_assets"',
  );
  expect(workflow).not.toContain('cp -a "$quality_download/." reports/quality-export/shards/');
  expect(workflow.slice(stagedEvidence, checksums)).toContain('test ! -e "assets/$asset"');
  expect(workflow.slice(stagedEvidence, checksums)).toContain(
    'cp "$QUALITY_ASSETS_DIR/$asset" "assets/$asset"',
  );
  expect(workflow).toContain('verify --commit "$RELEASE_COMMIT" --assets-dir "$download"');
});

test("release makes version images immutable first and exposes latest only after downloaded draft verification", () => {
  const immutablePush = position("- name: Push immutable version images");
  const draft = position("- name: Create GitHub release draft");
  const downloadAndVerify = position("- name: Download and verify release draft assets");
  const publish = position("- name: Publish verified GitHub release");
  const latest = position("- name: Push latest image aliases after release verification");

  expect(immutablePush).toBeLessThan(draft);
  expect(draft).toBeLessThan(downloadAndVerify);
  expect(downloadAndVerify).toBeLessThan(publish);
  expect(publish).toBeLessThan(latest);
  expect(workflow.slice(immutablePush, draft)).toContain('"$image:$VERSION"');
  expect(workflow.slice(immutablePush, draft)).not.toContain('"$image:latest"');
  expect(workflow.slice(draft, downloadAndVerify)).toContain("--draft --title");
  expect(workflow.slice(downloadAndVerify, publish)).toContain(
    "sha256sum --strict --check SHA256SUMS",
  );
  expect(workflow.slice(downloadAndVerify, publish)).toContain(
    "release-quality-evidence.ts verify",
  );
  expect(workflow.slice(publish, latest)).toContain("--draft=false");
  expect(workflow.slice(latest)).toContain('"$image:latest"');
});

test("the shell failure boundary leaves public release publication and latest aliases downstream", () => {
  const verify = position("- name: Download and verify release draft assets");
  const publish = position("- name: Publish verified GitHub release");
  const latest = position("- name: Push latest image aliases after release verification");
  const verificationStep = workflow.slice(verify, publish);

  expect(verificationStep).toContain("set -euo pipefail");
  expect(publish).toBeGreaterThan(verify);
  expect(latest).toBeGreaterThan(publish);
  expect(workflow.slice(verify, latest)).not.toContain('"$image:latest"');
});
