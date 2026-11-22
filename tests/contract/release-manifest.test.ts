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
      "subkit-darwin-arm64",
      "subkit-linux-arm64",
      "subkit-linux-x64",
      "subkit-windows-x64.exe",
      "docker-compose.yml",
      "subkit.config.example.json",
      "install.sh",
      "subkit-clipper.zip",
      "LICENSE",
      "THIRD_PARTY_NOTICES.txt",
    ]) {
      expect(extractStep).toContain(asset);
    }
    const checksumsStep = steps[checksums]?.run ?? "";
    expect(checksumsStep).toContain(
      "sha256sum engine_* subkit-darwin-arm64 subkit-linux-arm64 subkit-linux-x64 subkit-windows-x64.exe docker-compose.yml subkit.config.example.json install.sh subkit-clipper.zip LICENSE THIRD_PARTY_NOTICES.txt quality-evidence.tar.gz quality-evidence.json > SHA256SUMS",
    );
    expect(steps[draft]?.run ?? "").toContain(
      "assets/docker-compose.yml assets/subkit.config.example.json assets/install.sh assets/subkit-clipper.zip assets/LICENSE assets/THIRD_PARTY_NOTICES.txt",
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

describe("stable download links", () => {
  const latest = "https://github.com/MikeBild/subkit/releases/latest/download";
  const desktop = readFileSync(join(REPO, ".github/workflows/desktop-release.yml"), "utf8");
  const read = (path: string) => readFileSync(join(REPO, path), "utf8");
  const docs = (chapter: string) => [
    `apps/engine/src/http/reference/${chapter}.en.md`,
    `apps/engine/src/http/reference/${chapter}.de.md`,
  ];
  const links: [asset: string, files: string[]][] = [
    ["subkit-desktop-mac-arm64.dmg", ["README.md", ...docs("subkit-desktop")]],
    ["docker-compose.yml", ["README.md", ...docs("run-the-engine")]],
    ["subkit.config.example.json", docs("run-the-engine")],
    ["install.sh", docs("use-the-subkit-cli-on-your-machine")],
    ["subkit-clipper.zip", docs("web-clipper")],
  ];

  test("every guide links the latest release asset of the same name", () => {
    for (const [asset, files] of links)
      for (const file of files) expect(read(file)).toContain(`${latest}/${asset}`);
  });

  test("every linked asset is published with that name in each release", () => {
    const draft = steps[stepIndex("Create GitHub release draft")]?.run ?? "";
    for (const [asset] of links) {
      if (asset.startsWith("subkit-desktop-")) expect(desktop).toContain('sed "s/-$VERSION-/-/"');
      else expect(draft).toContain(`assets/${asset}`);
    }
  });
});
