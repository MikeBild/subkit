import { describe, expect, test } from "bun:test";
import { parseReleaseSecurityArgs, trivyHighCriticalFindings } from "../verify-release-security.ts";

describe("release security evidence", () => {
  test("requires an image and evidence output outside the repository", () => {
    expect(() => parseReleaseSecurityArgs([])).toThrow("usage:");
    expect(() =>
      parseReleaseSecurityArgs(["--image", "subkit:test", "--output-dir", ".artifacts"]),
    ).toThrow("outside the repository");
    expect(() =>
      parseReleaseSecurityArgs(["--image", "subkit:test", "--output-dir", "..evidence"]),
    ).toThrow("outside the repository");
    expect(
      parseReleaseSecurityArgs([
        "--image",
        "subkit:test",
        "--output-dir",
        "/tmp/subkit-security-evidence",
        "--assets-dir",
        "/tmp/subkit-assets",
      ]),
    ).toEqual({
      image: "subkit:test",
      outputDir: "/tmp/subkit-security-evidence",
      assetsDir: "/tmp/subkit-assets",
    });
  });

  test("keeps high and critical vulnerabilities, secrets, and misconfigurations fail-closed", () => {
    expect(
      trivyHighCriticalFindings({
        Results: [
          {
            Target: "runtime",
            Vulnerabilities: [
              {
                VulnerabilityID: "CVE-high",
                Severity: "HIGH",
                PkgName: "pkg",
                InstalledVersion: "1",
              },
              { VulnerabilityID: "CVE-low", Severity: "LOW" },
            ],
            Secrets: [{ RuleID: "secret", Severity: "CRITICAL", Title: "credential" }],
            Misconfigurations: [{ ID: "config", Severity: "HIGH", Title: "unsafe" }],
          },
        ],
      }),
    ).toEqual([
      {
        kind: "vulnerability",
        target: "runtime",
        id: "CVE-high",
        severity: "HIGH",
        title: "CVE-high",
        package: "pkg",
        installedVersion: "1",
      },
      {
        kind: "secret",
        target: "runtime",
        id: "secret",
        severity: "CRITICAL",
        title: "credential",
      },
      {
        kind: "misconfiguration",
        target: "runtime",
        id: "config",
        severity: "HIGH",
        title: "unsafe",
      },
    ]);
  });

  test("rejects malformed scanner evidence", () => {
    expect(() => trivyHighCriticalFindings(null)).toThrow("JSON object");
    expect(() => trivyHighCriticalFindings({})).toThrow("no results");
  });
});
