import type { OutputContractVerdict } from "./state.ts";
import type { ExecutionStatus } from "./types.ts";

interface TerminalFailure {
  code: string;
  message: string;
}

export function settleTerminalOutcome(run: {
  status: ExecutionStatus;
  timed_out: boolean;
  aborted: boolean;
  output_contract: OutputContractVerdict;
  failure: TerminalFailure | null;
}): {
  status: ExecutionStatus;
  output_contract: OutputContractVerdict;
  failure: TerminalFailure | null;
} {
  let status = run.status;
  let failure = run.failure;
  if (status === "succeeded" && run.timed_out) {
    status = "timed_out";
    failure = { code: "execution_timeout", message: "the run exceeded its total timeout" };
  } else if (status === "succeeded" && run.aborted) {
    status = "aborted";
    failure = { code: "execution_aborted", message: "the run was cancelled" };
  }
  return {
    status,
    output_contract: status === "succeeded" ? run.output_contract : "none",
    failure: status === "succeeded" ? null : failure,
  };
}
