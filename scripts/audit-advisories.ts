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

import { classifyAuditProcess } from "./lib/audit-process.ts";
import { readAuditReport } from "./lib/audit-report.ts";

const FAILING_SEVERITIES = new Set(["high", "critical"]);

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
const [rawStdout, rawStderr] = await Promise.all([
  new Response(proc.stdout).text(),
  new Response(proc.stderr).text(),
]);
await proc.exited;
const disposition = classifyAuditProcess(
  {
    stdout: rawStdout,
    stderr: rawStderr,
    exitCode: proc.exitCode,
    signalCode: proc.signalCode,
    killed: proc.killed,
  },
  TIMEOUT_MS,
);
if (disposition.kind === "unreachable") unreachable(disposition.reason);
const stdout = disposition.stdout;

// `bun audit` exits non-zero merely BECAUSE it found something, so the exit
// code says nothing on its own. The body is the only evidence.

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

const reading = readAuditReport(report);
// An answer we cannot read is our defect, not a clean tree. It still does not
// block — nothing in this repository waits for this job — but it must not print
// a verdict it has not earned. This shipped the other way: the reader looked up
// two keys the tool does not use, found nothing, and announced no advisories
// over a lockfile carrying one at high.
if (!reading.recognised) {
  unreachable("the answer was in a shape this reporter does not recognise");
}
const findings = reading.findings.filter((f) => FAILING_SEVERITIES.has(f.severity.toLowerCase()));

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
