// The advisory reader, against an answer the tool actually gave.
//
// The fixture is a slice of a real `bun audit --json` run in this repository,
// not a reconstruction — the whole reason this file exists is that the previous
// reader was written against a shape stated in a comment and never observed.
// Reconstructing the fixture from the same belief would reproduce the bug and
// call it covered.

import { describe, expect, test } from "bun:test";
import { readAuditReport } from "../lib/audit-report.ts";
import fixture from "./fixtures/bun-audit.json" with { type: "json" };

const FAILING = new Set(["high", "critical"]);

describe("readAuditReport — the shape bun actually answers in", () => {
  test("finds the advisories in a flat package map", () => {
    const { findings, recognised } = readAuditReport(fixture as Record<string, unknown>);
    expect(recognised).toBe(true);
    expect(findings.length).toBeGreaterThan(0);
  });

  test("the tree this shipped over really does carry a high advisory", () => {
    const { findings } = readAuditReport(fixture as Record<string, unknown>);
    const high = findings.filter((f) => FAILING.has(f.severity.toLowerCase()));
    expect(high.length).toBeGreaterThan(0);
    expect(high.some((f) => f.package.includes("faker"))).toBe(true);
  });

  test("every finding names a package, a severity and a title", () => {
    const { findings } = readAuditReport(fixture as Record<string, unknown>);
    for (const finding of findings) {
      expect(finding.package.length).toBeGreaterThan(0);
      expect(finding.severity).not.toBe("unknown");
      expect(finding.title).not.toBe("untitled advisory");
    }
  });

  test("severities below the bar are read, not dropped — the caller filters", () => {
    const { findings } = readAuditReport(fixture as Record<string, unknown>);
    expect(findings.some((f) => !FAILING.has(f.severity.toLowerCase()))).toBe(true);
  });
});

describe("readAuditReport — the older dialects", () => {
  test("npm's bulk vulnerabilities map", () => {
    const { findings, recognised } = readAuditReport({
      vulnerabilities: {
        axios: { name: "axios", severity: "high", via: [{ title: "SSRF" }] },
      },
    });
    expect(recognised).toBe(true);
    expect(findings).toEqual([{ package: "axios", severity: "high", title: "SSRF" }]);
  });

  test("an advisories map", () => {
    const { findings, recognised } = readAuditReport({
      advisories: { axios: [{ severity: "critical", title: "RCE", url: "https://example" }] },
    });
    expect(recognised).toBe(true);
    expect(findings[0]?.url).toBe("https://example");
  });
});

describe("readAuditReport — not understanding is not good news", () => {
  test("an empty answer is a clean tree and says so", () => {
    expect(readAuditReport({})).toEqual({ findings: [], recognised: true });
  });

  test("a shape with nothing advisory-like in it is NOT reported as clean", () => {
    const reading = readAuditReport({ something: { entirely: "different" }, count: 3 });
    expect(reading.findings).toHaveLength(0);
    // The bug this pins: zero findings used to print "no high or critical
    // advisories" over an answer the reader could not read at all.
    expect(reading.recognised).toBe(false);
  });

  test("a package whose entry is a bare string is not mistaken for an advisory", () => {
    expect(readAuditReport({ axios: "unexpected" }).recognised).toBe(false);
  });
});
