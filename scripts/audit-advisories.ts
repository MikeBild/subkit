#!/usr/bin/env bun
//
// The scheduled advisory check (`.github/workflows/audit.yml`).
//
// It answers ONE question — does this lockfile depend on something with a
// known high or critical advisory — and it refuses to answer any other. The
// reason is the outage of 2026-09-04: `npm audit --audit-level=high` sat in a
// release path, the registry's advisory endpoint answered 503 for hours, and a
// product's rollout was blocked while nothing was wrong with its code. A gate
// whose verdict depends on a third party's uptime is not a gate.
//
// So a registry that cannot be reached, or answers something that is not a
// parseable advisory report, is a WARNING and exit 0. Only an advisory that is
// actually reported at high or critical severity fails, and the failure names
// package, severity and title so the reader can act without rerunning it.
//
// This job is never a required check and nothing depends on it.

import { appendFileSync } from "node:fs";

const FAILING_SEVERITIES = new Set(["high", "critical"]);

interface Finding {
  package: string;
  severity: string;
  title: string;
  url?: string;
}

function summary(lines: string[]): void {
  const path = process.env.GITHUB_STEP_SUMMARY;
  const text = `${lines.join("\n")}\n`;
  process.stdout.write(text);
  if (!path) return;
  try {
    appendFileSync(path, text);
  } catch {
    // A summary that cannot be written must not change the verdict.
  }
}

/** The registry said nothing usable. That is not a finding. */
function unreachable(reason: string): never {
  summary([
    "### Advisory check skipped",
    "",
    `The advisory registry gave no usable answer: ${reason}.`,
    "",
    "This is reported as a warning on purpose — a network fault is not a vulnerability,",
    "and nothing in this repository waits for this job.",
  ]);
  process.exit(0);
}

/**
 * Both shapes seen in the wild: `bun audit --json` reports
 * `{ advisories: { "<package>": [ … ] } }`, npm's bulk endpoint reports
 * `{ vulnerabilities: { "<package>": { severity, via: [ … ] } } }`.
 */
function collect(report: Record<string, unknown>): Finding[] {
  const out: Finding[] = [];

  const advisories = report.advisories;
  if (advisories && typeof advisories === "object") {
    for (const [name, entries] of Object.entries(advisories as Record<string, unknown>)) {
      for (const entry of Array.isArray(entries) ? entries : [entries]) {
        const item = entry as Record<string, unknown>;
        out.push({
          package: typeof item.module_name === "string" ? item.module_name : name,
          severity: String(item.severity ?? "unknown"),
          title: String(item.title ?? "untitled advisory"),
          ...(typeof item.url === "string" ? { url: item.url } : {}),
        });
      }
    }
  }

  const vulnerabilities = report.vulnerabilities;
  if (vulnerabilities && typeof vulnerabilities === "object" && !Array.isArray(vulnerabilities)) {
    for (const [name, raw] of Object.entries(vulnerabilities as Record<string, unknown>)) {
      const entry = raw as Record<string, unknown>;
      const via = Array.isArray(entry.via) ? entry.via : [];
      const titles = via
        .filter((v): v is Record<string, unknown> => typeof v === "object" && v !== null)
        .map((v) => String(v.title ?? "untitled advisory"));
      out.push({
        package: typeof entry.name === "string" ? entry.name : name,
        severity: String(entry.severity ?? "unknown"),
        title: titles.length ? titles.join("; ") : "untitled advisory",
      });
    }
  }

  return out;
}

// A registry that accepts the connection and then never answers would hang
// the job until the runner's own limit — the same "blocked by somebody else's
// weather" this workflow exists to avoid. The wait is bounded, and running out
// of it is an outage, not a finding.
const TIMEOUT_MS = 120_000;

const proc = Bun.spawn(["bun", "audit", "--json"], {
  stdin: "ignore",
  stdout: "pipe",
  stderr: "pipe",
  timeout: TIMEOUT_MS,
});
const [stdout, stderr] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
]).then(([out, err]) => [out.trim(), err.trim()] as const);
await proc.exited;
if (proc.killed) unreachable(`no answer within ${TIMEOUT_MS / 1000}s`);

// `bun audit` exits non-zero merely BECAUSE it found something, so the exit
// code says nothing on its own. The body is the only evidence.
if (!stdout) unreachable(stderr ? `no output (${stderr.split("\n")[0]})` : "no output");

let report: Record<string, unknown>;
try {
  const parsed: unknown = JSON.parse(stdout);
  if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
  report = parsed as Record<string, unknown>;
} catch (err) {
  unreachable(`the response was not parseable JSON (${(err as Error).message})`);
}

if (report.error !== undefined) {
  const detail = report.error;
  const text =
    typeof detail === "object" && detail !== null
      ? String((detail as Record<string, unknown>).summary ?? JSON.stringify(detail))
      : String(detail);
  unreachable(`the registry answered with an error (${text})`);
}

const findings = collect(report).filter((f) => FAILING_SEVERITIES.has(f.severity.toLowerCase()));

if (findings.length === 0) {
  summary([
    "### No high or critical advisories",
    "",
    "The advisory registry answered, and nothing this lockfile depends on carries",
    "a known advisory at high or critical severity.",
  ]);
  process.exit(0);
}

summary([
  `### ${findings.length} high or critical advisory/advisories`,
  "",
  "| Package | Severity | Advisory |",
  "|---|---|---|",
  ...findings.map((f) => `| \`${f.package}\` | ${f.severity} | ${f.title} |`),
]);
process.exit(1);
