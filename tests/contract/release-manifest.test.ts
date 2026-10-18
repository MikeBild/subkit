import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const WORKFLOW = readFileSync(join(REPO, ".github/workflows/release.yml"), "utf8");

describe("release manifest workflow", () => {
  test("publishing artifacts cannot dispatch a deployment to another repository", () => {
    expect(WORKFLOW).not.toContain("/dispatches");
    expect(WORKFLOW).not.toContain("repository_dispatch");
    expect(WORKFLOW).not.toContain("DEPLOY_TOKEN");
    expect(WORKFLOW).toContain("- name: Require mandatory local release gate");
    expect(WORKFLOW).toContain("- name: Sign SHA256SUMS");
  });

  test("checksums every shipped artifact and signs the manifest before publishing", () => {
    const extract = WORKFLOW.indexOf("- name: Extract release binaries from the image");
    const sign = WORKFLOW.indexOf("- name: Sign SHA256SUMS");
    const verify = WORKFLOW.indexOf("- name: Verify signature against the updater trust root");
    const upload = WORKFLOW.indexOf("- name: Push image");
    const publish = WORKFLOW.indexOf("- name: Publish GitHub release");

    expect(extract).toBeGreaterThan(-1);
    expect(sign).toBeGreaterThan(extract);
    expect(verify).toBeGreaterThan(sign);
    expect(upload).toBeGreaterThan(verify);
    expect(publish).toBeGreaterThan(upload);
    expect(WORKFLOW.slice(verify, upload)).toContain(
      "./packages/cli-core/src/release-public-key.ts",
    );

    const extractStep = WORKFLOW.slice(extract, sign);
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
    expect(extractStep).toContain(
      "sha256sum engine_* sk_* docker-compose.yml subkit-clipper.zip LICENSE THIRD_PARTY_NOTICES.txt > SHA256SUMS",
    );
    expect(WORKFLOW.slice(publish)).toContain(
      "assets/docker-compose.yml assets/subkit-clipper.zip assets/LICENSE assets/THIRD_PARTY_NOTICES.txt",
    );
    expect(WORKFLOW.slice(sign, publish)).toContain("-out assets/SHA256SUMS.sig");
  });
});
