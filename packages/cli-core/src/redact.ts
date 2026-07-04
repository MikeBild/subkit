import { redactWithMaxDepth } from "@shared/redaction.ts";

// Operator-debugging depth. Tool envelopes legitimately nest 5–7
// levels (tool_result.output.summary.checkpoints[…].verified_by_tool;
// build_workflow.errors[].path; propose_step.errors[].message).
// Pre-fix MAX_DEPTH=4 collapsed those to "[depth-exceeded]" in the
// debug log, so an operator grepping `~/.sk/debug.log` for "what
// went wrong" saw only opaque markers — exactly the symptom in
// session 0a01c5f3 ("a lot of warning messages but they disappear").
const MAX_DEPTH = 16;

/**
 * Public redactor. Runs the legacy denylist + Bearer/Slack/wf_/postgres
 * scrubbers, then layers the secret-shape scrubber on top so PATs
 * (`dop_v1_…`, `ghp_…`, …), JWTs, and AWS access keys are caught even
 * when they appear in free-form text outside a sensitive key.
 */
export function redact(input: unknown, depth = 0): unknown {
  return redactWithMaxDepth(input, MAX_DEPTH, depth);
}
