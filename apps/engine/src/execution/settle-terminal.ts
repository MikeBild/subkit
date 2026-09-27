// What a finishing run records once its status is final.
//
// The output_schema verdict is taken while the run still reads `succeeded`;
// the total timeout or an abort can turn it `timed_out` / `aborted` after
// that. A verdict recorded before the status settled would then report
// `passed` on a run that did not complete. Settle the status first, then keep
// the verdict only for a run that really succeeded — and give a run stopped
// that way a failure record, so it does not read as failed-without-a-cause.

import type { OutputContractVerdict } from "./state.ts";
import type { ExecutionStatus } from "./types.ts";

export interface TerminalFailure {
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
