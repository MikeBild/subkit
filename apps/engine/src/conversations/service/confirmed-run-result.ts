type RunCall = {
  id: string;
  tool: string;
  input: unknown;
  output: unknown;
  outcome: string | null;
};

const isEngineRunResult = (call: RunCall): boolean =>
  call.tool === "run_workflow" &&
  call.input !== null &&
  typeof call.input === "object" &&
  (call.input as { _harness_auto_persist?: unknown })._harness_auto_persist === true;

export function pairConfirmedRunResults(
  calls: readonly RunCall[],
  isConfirmed: (id: string) => boolean,
): Map<string, RunCall> {
  const pairs = new Map<string, RunCall>();
  const waiting: string[] = [];
  for (const call of calls) {
    if (isEngineRunResult(call)) {
      const confirmed = waiting.pop();
      if (confirmed) pairs.set(confirmed, call);
    } else if (call.tool === "run_workflow" && isConfirmed(call.id)) {
      waiting.push(call.id);
    }
  }
  return pairs;
}
