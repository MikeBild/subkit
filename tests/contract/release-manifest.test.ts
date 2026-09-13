// Release-manifest workflow contract.
//
// A release is only trustworthy when the signed SHA256SUMS manifest covers
// every published payload, including the SBOM, and never hashes its own temp
// file. Keep this as a cheap source-level contract because the signing key is
// intentionally available only inside the release job.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

const REPO = join(import.meta.dir, "..", "..");
const WORKFLOW = readFileSync(join(REPO, ".github/workflows/release.yml"), "utf8");

describe("release manifest workflow", () => {
  test("generates the SBOM before checksums and signs only the complete manifest", () => {
    const sbom = WORKFLOW.indexOf("- name: Generate SBOM (CycloneDX)");
    const sums = WORKFLOW.indexOf("- name: Generate SHA256SUMS");
    const sign = WORKFLOW.indexOf("- name: Sign SHA256SUMS (Ed25519)");

    expect(sbom).toBeGreaterThan(-1);
    expect(sums).toBeGreaterThan(sbom);
    expect(sign).toBeGreaterThan(sums);

    const sumsStep = WORKFLOW.slice(sums, sign);
    expect(sumsStep).toContain("sums_tmp=$(mktemp)");
    expect(sumsStep).toContain('done > "$sums_tmp"');
    expect(sumsStep).not.toContain("> SHA256SUMS.tmp");
    expect(sumsStep).toContain("sbom_actual");
    expect(sumsStep).toContain('test "$sbom_actual" -eq 1');
    expect(sumsStep).toContain("if grep -Eq 'SHA256SUMS|\\.sig$' SHA256SUMS; then");
    expect(sumsStep).toContain("SHA256SUMS must not hash itself or signature files");
  });
});
