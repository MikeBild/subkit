// Classify the subprocess outcome separately from the advisory JSON reader.
//
// Bun marks `Subprocess.killed` true for an ordinary non-zero exit as well as
// for a signal. `bun audit` deliberately exits 1 when it found advisories, so
// using `killed` as the timeout test discarded the very report this job exists
// to read. A signal is the evidence that the configured timeout terminated the
// child; the exit code is intentionally not part of the verdict.

export interface AuditProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signalCode: number | null;
  killed: boolean;
}

export type AuditProcessDisposition =
  | { kind: "report"; stdout: string }
  | { kind: "unreachable"; reason: string };

export function classifyAuditProcess(
  result: AuditProcessResult,
  timeoutMs: number,
): AuditProcessDisposition {
  if (result.signalCode !== null) {
    return { kind: "unreachable", reason: `no answer within ${timeoutMs / 1000}s` };
  }
  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (!stdout) {
    return {
      kind: "unreachable",
      reason: stderr ? `no output (${stderr.split("\n")[0]})` : "no output",
    };
  }
  return { kind: "report", stdout };
}
