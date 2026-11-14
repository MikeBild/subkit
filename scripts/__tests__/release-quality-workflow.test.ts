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

test("release reuses one exact-commit quality producer and carries its verified coverage into signed draft assets", () => {
  expect(workflow).not.toContain("uses: ./.github/workflows/quality.yml");
  expect(workflow).not.toContain("needs: quality");
  const select = position("Select completed exact-commit quality producer");
  const coverageDownload = position("actions/artifacts/$COVERAGE_ARTIFACT_ID/zip");
  const canonicalCoverage = position('test -f "$coverage_download/latest.json"');
  const localGate = position("- name: Require mandatory local release gate");
  const packageEvidence = position("scripts/release-quality-evidence.ts package");
  const releaseNotes = position("- name: Generate release notes");
  const stagedEvidence = position("- name: Stage verified quality evidence in release assets");
  const checksums = position("quality-evidence.tar.gz quality-evidence.json > SHA256SUMS");
  const draftAssets = position("assets/quality-evidence.tar.gz assets/quality-evidence.json");

  expect(coverageDownload).toBeGreaterThan(select);
  expect(canonicalCoverage).toBeGreaterThan(coverageDownload);
  expect(localGate).toBeGreaterThan(canonicalCoverage);
  expect(packageEvidence).toBeGreaterThan(localGate);
  expect(releaseNotes).toBeGreaterThan(packageEvidence);
  expect(stagedEvidence).toBeGreaterThan(releaseNotes);
  expect(checksums).toBeGreaterThan(stagedEvidence);
  expect(draftAssets).toBeGreaterThan(checksums);
  expect(workflow).toContain('select-release-quality-run.ts select --commit "$RELEASE_COMMIT"');
  expect(workflow).toContain('select-release-quality-run.ts verify --commit "$RELEASE_COMMIT"');
  expect(workflow).toContain('select-release-quality-run.ts artifacts --commit "$RELEASE_COMMIT"');
  expect(workflow).toContain(
    "actions/workflows/quality.yml/runs?event=push&head_sha=$RELEASE_COMMIT",
  );
  expect(workflow).toContain("QUALITY_RUN_ATTEMPT=$(jq -er");
  expect(workflow).toContain("quality-run-before-download.json");
  expect(workflow).toContain("quality-artifacts-before-download.json");
  expect(workflow).toContain('sha256sum "$RUNNER_TEMP/coverage-floor-evidence.zip"');
  expect(workflow).toContain("unsafe coverage artifact archive member");
  expect(workflow).toContain(
    ' --quality-run-id "$QUALITY_RUN_ID" --release-run-id "$GITHUB_RUN_ID"',
  );
  expect(workflow).toContain(
    'scripts/release-gate-provenance.ts "$RUNNER_TEMP/release-gate.json" "$TAG" "$RELEASE_COMMIT"',
  );
  expect(workflow).not.toContain("quality-shard-evidence");
  expect(workflow).not.toContain("--shard-index");
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
