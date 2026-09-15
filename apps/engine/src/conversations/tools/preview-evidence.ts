/** Evidence for the assistant's summary; held/skipped work is never counted as tested. */
export function previewEvidence(
  steps: ReadonlyArray<{ step_key: string; status: string; held?: boolean }>,
) {
  return {
    checked_steps: steps
      .filter((step) => step.status === "succeeded" && !step.held)
      .map((step) => step.step_key),
    held_steps: steps.filter((step) => step.held).map((step) => step.step_key),
    skipped_steps: steps
      .filter((step) => step.status === "skipped" && !step.held)
      .map((step) => step.step_key),
    failed_steps: steps
      .filter((step) => step.status === "failed" && !step.held)
      .map((step) => step.step_key),
    guidance:
      "Summarize the verified result in the user's language. Held and skipped operations were not tested; never describe them as successful or claim a live execution. Explain the concrete limitation and recommended next action without internal tool names.",
  };
}
