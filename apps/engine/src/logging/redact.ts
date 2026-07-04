import { redactWithMaxDepth } from "@shared/redaction.ts";

const MAX_DEPTH = 4;

/**
 * Public redactor. Runs the legacy denylist + Bearer/Slack/wf_/postgres
 * scrubbers, then layers the secret-shape scrubber on top so PATs
 * (`dop_v1_…`, `ghp_…`, …), JWTs, and AWS access keys are caught even
 * when they appear in free-form text outside a sensitive key.
 */
export function redact(input: unknown, depth = 0): unknown {
  return redactWithMaxDepth(input, MAX_DEPTH, depth);
}
