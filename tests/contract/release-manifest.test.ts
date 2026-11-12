import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const WORKFLOW = readFileSync(join(REPO, ".github/workflows/release.yml"), "utf8");
const workflow = Bun.YAML.parse(WORKFLOW) as {
  jobs: { release: { steps: Array<{ name?: string; run?: string }> } };
};
const steps = workflow.jobs.release.steps;

function stepIndex(name: string): number {
  const index = steps.findIndex((step) => step.name === name);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

describe("release manifest workflow", () => {
  test("a tag publishes the image to Docker Hub and nothing else deploys it", () => {
    expect(WORKFLOW).not.toContain("subkit-deploy");
    expect(WORKFLOW).not.toContain("/dispatches");
    expect(WORKFLOW).not.toContain("SUBKIT_DEPLOY_DISPATCH_TOKEN");
    expect(stepIndex("Require mandatory local release gate")).toBeGreaterThan(-1);
    const immutable = stepIndex("Push immutable version images");
    const latest = stepIndex("Push latest image aliases after release verification");
    const immutableRun = steps[immutable]?.run ?? "";
    const latestRun = steps[latest]?.run ?? "";
    for (const registry of ["docker.io/mikebild/subkit", "ghcr.io/mikebild/subkit"]) {
      expect(immutableRun).toContain(registry);
      expect(latestRun).toContain(registry);
    }
    expect(immutableRun).toContain('docker tag subkit:release "$image:$VERSION"');
    expect(immutableRun).toContain('docker push "$image:$VERSION"');
    expect(immutableRun).not.toContain('"$image:latest"');
    expect(latestRun).toContain('docker tag subkit:release "$image:latest"');
    expect(latestRun).toContain('docker push "$image:latest"');
  });

  test("signs complete assets, verifies the downloadable draft, then publishes latest last", () => {
    const extract = stepIndex("Extract release binaries from the image");
    const stageEvidence = stepIndex("Stage verified quality evidence in release assets");
    const checksums = stepIndex("Write release checksums");
    const sign = stepIndex("Sign SHA256SUMS");
    const trustRoot = stepIndex("Verify signature against the updater trust root");
    const immutable = stepIndex("Push immutable version images");
    const draft = stepIndex("Create GitHub release draft");
    const download = stepIndex("Download and verify release draft assets");
    const publish = stepIndex("Publish verified GitHub release");
    const latest = stepIndex("Push latest image aliases after release verification");

    expect(stageEvidence).toBeGreaterThan(extract);
    expect(checksums).toBeGreaterThan(stageEvidence);
    expect(sign).toBeGreaterThan(checksums);
    expect(trustRoot).toBeGreaterThan(sign);
    expect(immutable).toBeGreaterThan(trustRoot);
    expect(draft).toBeGreaterThan(immutable);
    expect(download).toBeGreaterThan(draft);
    expect(publish).toBeGreaterThan(download);
    expect(latest).toBeGreaterThan(publish);

    const extractStep = steps[extract]?.run ?? "";
    for (const asset of [
      "engine_linux_x64",
      "sk_darwin_arm64",
      "sk_darwin_x64",
      "sk_linux_arm64",
      "sk_linux_x64",
      "sk_windows_x64.exe",
      "docker-compose.yml",
      "subkit-clipper.zip",
      "LICENSE",
      "THIRD_PARTY_NOTICES.txt",
    ]) {
      expect(extractStep).toContain(asset);
    }
    const checksumsStep = steps[checksums]?.run ?? "";
    expect(checksumsStep).toContain(
      "sha256sum engine_* sk_* docker-compose.yml subkit-clipper.zip LICENSE THIRD_PARTY_NOTICES.txt quality-evidence.tar.gz quality-evidence.json > SHA256SUMS",
    );
    expect(steps[draft]?.run ?? "").toContain(
      "assets/docker-compose.yml assets/subkit-clipper.zip assets/LICENSE assets/THIRD_PARTY_NOTICES.txt",
    );
    expect(steps[draft]?.run ?? "").toContain(
      "assets/quality-evidence.tar.gz assets/quality-evidence.json",
    );
    expect(steps[sign]?.run ?? "").toContain("-out assets/SHA256SUMS.sig");
    expect(steps[trustRoot]?.run ?? "").toContain("./packages/cli-core/src/release-public-key.ts");
    expect(steps[trustRoot]?.run ?? "").toContain("verify(null,");
    const downloaded = steps[download]?.run ?? "";
    expect(downloaded).toContain("sha256sum --strict --check SHA256SUMS");
    expect(downloaded).toContain("./packages/cli-core/src/release-public-key.ts");
    expect(downloaded).toContain("verify(null,");
    expect(downloaded).toContain("release-quality-evidence.ts verify");
    expect(steps[publish]?.run ?? "").toContain('gh release edit "$TAG" --draft=false');
    expect(steps[latest]?.run ?? "").toContain('"$image:latest"');
  });
});
