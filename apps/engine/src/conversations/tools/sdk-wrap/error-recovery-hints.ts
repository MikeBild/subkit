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
  // Surface-restriction signals from the unified tool dispatcher.
  not_available_on_surface:
    "this tool exists in the catalog but cannot be invoked from the current surface — for draft_write tools (save_workflow_draft, dry_run_workflow), the operator must drive the call from a chat conversation, not a headless MCP session",
  // Authoring guardrails — the model called the wrong tool first.
  transform_authoring_requires_inspect:
    "call inspect_execution_step(execution_id, step_key, include_full_payload: true) to read the upstream step's actual shape before authoring the transform",
  loop_authoring_requires_inspect:
    "call inspect_execution_step against the loop step to see the body shape before authoring or modifying the loop",
  step_update_invalid:
    "the current draft step is invalid — call inspect_workflow_draft to see the validation errors, then propose_step with the corrected fields",
  step_invalid:
    "the step shape is wrong — call inspect_workflow_draft for the validation breakdown, then propose_step or update_param against the failing field",
  unknown_step:
    "the referenced step_id does not exist — call inspect_workflow_draft to list the actual step ids",
  step_not_found:
    "the referenced step did not run in the execution — call inspect_workflow to list step_keys, or run_workflow to produce a fresh execution",
  unresolved_identifier:
    "the JSONata referenced a name not in scope — call suggest_jsonata_paths(workflow_id_or_draft) for the authoritative path list",
  expression_invalid:
    "the JSONata/JS expression is invalid — call suggest_jsonata_paths for available scope keys, then dry_run_transform to validate before saving",
  workflow_unresolved_step_reference:
    "a step referenced an id that doesn't exist — call inspect_workflow_draft to list step ids and connect_steps to wire missing edges",
  workflow_unsupported_placeholder:
    "a placeholder used an unsupported binding — call suggest_jsonata_paths for valid placeholders, or update_param to replace it",
  workflow_cycle_detected:
    "the workflow has a step-dependency cycle — call inspect_workflow_draft to see the graph, then propose_step / connect_steps to remove the cycle",
  workflow_schema_invalid:
    "the workflow schema is invalid — call validate_draft for the field-level errors, then update_param / propose_step to fix",
  patch_invalid:
    "the patch failed validation — call validate_draft to see the per-field errors, then re-issue edit_workflow_patch with the corrections",
  // Lookup / discovery — recover by calling the matching find_* tool.
  http_4xx:
    "the request returned 4xx — call probe_connector to verify the endpoint shape, headers, and auth before retrying",
  execution_not_found:
    "the execution id is stale — call list_executions to get a current id, or run_workflow to produce a fresh execution",
  execution_missing:
    "the execution id is stale — call list_executions to get a current id, or run_workflow to produce a fresh execution",
  no_executions:
    "this tenant has not run anything yet — call run_workflow to produce an execution before inspecting one",
  workflow_not_found:
    "the workflow id is unknown on this tenant — call find_workflow or list_workflows to discover the correct id",
  workflow_not_persisted:
    "the workflow draft has not been saved — call dry_run_workflow (which auto-commits on a clean preview) or save_workflow_draft",
  connector_not_found:
    "the connector id is unknown — call find_connector or list_connectors to discover the correct id",
  connector_missing:
    "no connector is bound for this operation — call find_connector or start_connector_from_description to create one",
  connector_bindings_missing:
    "the workflow step is missing a connector binding — call inspect_workflow_draft to see required bindings, then update_param to attach a connector",
  connector_bindings_required:
    "this step needs a connector — call find_connector or start_connector_from_description, then update_param to bind it",
  connector_template_unknown:
    "the connector template slug is unknown — call suggest_connector_templates (or match_connector_template_by_url for a URL) to find a real template",
  unknown_template:
    "the template slug is unknown — call suggest_connector_templates to find a matching template",
  connector_recipe_unknown:
    "the recipe is unknown — call inspect_recipe with a real recipe slug, or get_vendor_recipe to discover the canonical one",
  role_not_found:
    "the role does not exist — call find_role or list_roles to discover the correct slug",
  user_not_found:
    "the user does not exist on this tenant — call find_user or list_users to discover the correct id",
  knowledge_source_not_found:
    "the knowledge source id is unknown — call list_knowledge_sources to discover the correct id",
  snapshot_not_found:
    "the snapshot id is stale or wrong — call list_draft_snapshots to discover the correct id",
  no_snapshot_available:
    "no draft snapshot exists yet — call list_draft_snapshots after the next draft mutation, or build_workflow / propose_step to seed one",
  // Preview / pre-run state.
  step_not_in_preview:
    "the step did not run in the last preview — call dry_run_workflow or run_workflow first to populate the preview",
  no_preview_recorded:
    "the workflow has no recorded preview — call dry_run_workflow to produce one before reading step results",
  preview_empty:
    "the last preview produced no output — call run_workflow with concrete input, or dry_run_workflow with a non-empty input payload",
  // Loops & repair.
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
