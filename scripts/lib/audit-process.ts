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
