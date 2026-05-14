// Concrete-alternative messaging for the consecutive-failures cap
// (`MAX_CONSECUTIVE_FAILURES`). The existing cap fires when the model
// makes too many failing tool calls in a row — but its message only
// said "ask the user." Reading `signals.toolLastErrorHash` lets us
// name the actual recovery tool for each error code the model has
// seen this turn, so the surfaced `ask_user_choice` offers realistic
// options.
//
// Lives in its own module so adding the next code doesn't churn
// `invoke.ts`, and so the unit test can assert the catalogue is
// complete by importing from one canonical location.

/**
 * Maps known error codes to concrete next-action suggestions for the
 * model. Add a new entry whenever a new structured `error_code` ships
 * from a tool's `ok: false` branch — the cap message will then name
 * the recovery path for that code automatically.
 *
 * Update sites: every conversation tool that returns
 * `{ ok: false, data: { error_code: "..." } }` should appear here or
 * the cap surfaces only the generic "ask the user" hint.
 */
export const ERROR_CODE_ALTERNATIVES: Readonly<Record<string, string>> = {
  transform_authoring_requires_inspect:
    "call inspect_execution_step(execution_id, step_key, include_full_payload: true) to read the upstream step's actual shape before authoring the transform",
  step_update_invalid:
    "the current draft step is invalid — call inspect_workflow_draft to see the validation errors, then propose_step with the corrected fields",
  step_invalid:
    "the step shape is wrong — call inspect_workflow_draft for the validation breakdown, then propose_step or update_param against the failing field",
  unknown_step:
    "the referenced step_id does not exist — call inspect_workflow_draft to list the actual step ids",
  unresolved_identifier:
    "the JSONata referenced a name not in scope — call suggest_jsonata_paths(workflow_id_or_draft) for the authoritative path list",
  http_4xx:
    "the request returned 4xx — call probe_connector to verify the endpoint shape, headers, and auth before retrying",
  execution_not_found:
    "the execution id is stale — call list_executions to get a current id, or run_workflow to produce a fresh execution",
  verifier_rejected:
    "the workflow verifier rejected the change — read the rejection reason and either revise the patch or call ask_user_confirm to confirm an exception",
  repair_loop_detected:
    "three consecutive runs surfaced the same authoring warning — stop, read data-handling.md / workflow-authoring.md, and propose a structurally different draft",
};

/**
 * Build the "Concrete alternatives" block appended to the
 * consecutive-failures cap messages in `sdk-wrap/invoke.ts`. Reads
 * `signals.toolLastErrorHash` (shape: `${reason}|${err.slice(0,120)}`)
 * and emits one bullet per distinct error code that has a mapping in
 * `ERROR_CODE_ALTERNATIVES`. Returns the empty string when nothing is
 * recognised so the caller can just `${msg}${alternatives}` without a
 * conditional.
 *
 * @internal — exported for unit testing only. Not part of any public
 * surface; do not import from outside `sdk-wrap/`.
 */
export function buildCapAlternatives(toolLastErrorHash: ReadonlyMap<string, string>): string {
  if (toolLastErrorHash.size === 0) return "";
  const seenCodes = new Set<string>();
  const lines: string[] = [];
  for (const shape of toolLastErrorHash.values()) {
    const reason = shape.split("|", 1)[0] ?? "";
    if (!reason || seenCodes.has(reason)) continue;
    seenCodes.add(reason);
    const hint = ERROR_CODE_ALTERNATIVES[reason];
    if (hint) lines.push(`  • ${reason}: ${hint}`);
  }
  if (lines.length === 0) return "";
  return `\nConcrete alternatives derived from the recent failures:\n${lines.join("\n")}`;
}
