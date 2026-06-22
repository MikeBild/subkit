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

import {
  ELICITATION_ALREADY_RESOLVED,
  ELICITATION_TRANSPORT_FAILED,
  INVALID_ELICIT_RESPONSE,
  OAUTH_AUTHORIZATION_DECLINED,
  OAUTH_AUTHORIZATION_FAILED,
  OAUTH_ELICITATION_TRANSPORT_FAILED,
  OAUTH_TIMEOUT,
} from "../error-codes.ts";

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
  // Caller bypassed auth: ToolContext arrived without a principal. Production
  // callers always thread it from the auth resolution; a refusal here means
  // an upstream caller dropped the principal. Re-issue via an authenticated
  // surface (HTTP/MCP route, not a raw in-process invocation).
  principal_required:
    "this tool requires an authenticated principal on the ToolContext — re-issue the call from the HTTP / MCP / sk-cli surface so the auth resolution threads through, instead of invoking the tool directly in-process",
  // Initial-stage gate (Fix A): micro-tools are repair-stage only.
  authoring_stage_violation:
    "propose_step / update_param are repair-stage tools — the draft has no recorded preview and no recorded-eval/judge findings yet. Author the complete workflow in ONE call via author_workflow (or build_workflow), then dry_run_workflow; either unlocks the micro-tools",
  legacy_itemvar_migration_required:
    "this workflow predates the $item contract and the automatic rewrite could not be proven equivalent — read the named step/field, rewrite its bare loop-variable references to $item yourself, include that change in the patch, and retry edit_workflow_patch",
  // Authoring guardrails — evidence is fingerprint-keyed: edits to
  // OTHER steps keep their recorded previews; only the referenced
  // step's own definition change invalidates it.
  transform_authoring_requires_inspect:
    "the transform references a step with no fingerprint-valid recorded preview (its definition changed since the last preview, or it was never previewed) — call dry_run_workflow ONCE to refresh the evidence, then retry the same edit; unchanged steps keep their evidence, so one dry-run suffices. Read the recorded shape via inspect_workflow_draft or inspect_execution_step(execution_id, step_key, include_full_payload: true) before re-authoring",
  transform_hand_rolled_codec:
    "the transform re-implements a base64 / base32 / hex codec using a hand-rolled alphabet literal or lookup table — use the deterministic sandbox primitives instead: sk.base64Encode, sk.base64UrlEncode, sk.base64EncodeUtf8, sk.base64UrlEncodeUtf8, sk.base64DecodeUtf8, sk.hexEncode, sk.hexDecode. These are FIPS-correct, immune to source-text corruption, and always produce valid output; a hand-rolled encoder can silently emit 'undefined' if its alphabet literal is ever redacted",
  loop_authoring_requires_inspect:
    "the loop's `over`/`data_selector` references a step with no fingerprint-valid recorded preview (its definition changed since the last preview, or it was never previewed) — call dry_run_workflow ONCE to refresh the evidence, then retry the same edit; unchanged steps keep their evidence, so one dry-run suffices. Read the recorded shape via suggest_jsonata_paths or inspect_workflow_draft before re-authoring",
  preview_stale_for_referenced_step:
    "the referenced step's OWN definition changed since its preview was recorded, so the evidence is stale — call dry_run_workflow once to refresh it, then retry the same edit; edits to other steps do NOT invalidate evidence, so this fires only when the step you reference actually changed",
  step_update_invalid:
    'the current draft step is invalid — call inspect_workflow_draft to see the validation errors, then propose_step with the corrected fields. Common case: a loop\'s `body` must be an ARRAY of step ids (body: ["step_id"]), never a string and never inline step objects',
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
  workflow_unsupported_placeholder: `a placeholder used an unsupported binding — the resolver accepts only cred|connector|input|scope|item|state. Inside a loop body: use \${item.<path>} in request strings (path/url/headers/query/body) and $item.<path> in JSONata expressions — bare item names (project.name), \${project.id}, \${user.email}, and Mustache {{…}} are all rejected. Call suggest_jsonata_paths for valid forms, or update_param to replace it`,
  placeholder_unresolved: `a \${…} placeholder did not resolve from scope at runtime — inside a loop body write \${item.<path>} in request strings and $item.<path> in JSONata expressions (never a bare item name); for sibling body steps use \${scope.<body_step_id>.data.<field>}. Verify the path against the recorded preview via inspect_workflow_draft, then re-run dry_run_workflow`,
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
    "no runnable workflow yet. If you are AUTHORING a new workflow (the user said build/create/make a workflow), call build_workflow (one-shot) or propose_step (incremental) — do NOT call run_workflow again. If a draft already exists, call dry_run_workflow (auto-commits on a clean preview) or save_workflow_draft. Never retry run_workflow with the same args.",
  credential_form_mismatch:
    "the credential form's field names don't match the canonical slots for this auth_type — re-issue ask_user_form using the canonical names (bearer→token; basic→username,password; header→header_name,header_value; query→param,value; aws_sigv4→access_key_id,secret_access_key; oauth2→client_id,client_secret); see the `missing` list in the result envelope",
  probe_unchanged:
    "this exact probe already failed and nothing changed since — do NOT re-probe with the same draft. Change the base_url / credential / config via update_connector_draft, or verify the endpoint via fetch_connector_docs / search_docs first",
  connector_not_found:
    "the connector id is unknown — call find_connector or list_connectors to discover the correct id",
  connector_missing:
    "no connector is bound for this operation — call find_connector or start_connector_from_description to create one",
  oauth_requires_template:
    "this oauth2 draft has no template, so its oauth metadata cannot be authored on the draft — call start_connector_from_template with an existing template, or register one via POST /v1/connector-templates (admin); do not retry update_connector_draft with oauth fields",
  auth_param_name_in_config:
    'config has no slot for the query parameter name — for query auth the param name lives in the credential\'s `param` field. Set auth_type:"query" on the draft, then collect the secret via ask_user_form(type:password, sensitive:true) and submit save_connector_draft({credential:{mode:"query", param:"<param-name>", value:"<token>"}}) (e.g. param:"token" for Browserless). Remove the key from config.',
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
  // Connector authoring gates — auth_type must be set before credentials are collected.
  connector_auth_unset:
    "the connector draft has no auth_type — call update_connector_draft with the correct auth_type (bearer, basic, api_key, oauth2, or none) before asking for credentials",
  // Loops & repair.
  verifier_rejected:
    "the workflow verifier rejected the change — read the rejection reason and either revise the patch or call ask_user_confirm to confirm an exception",
  repair_loop_detected:
    "three consecutive runs surfaced the same authoring warning — stop, read data-handling.md / workflow-authoring.md, and propose a structurally different draft",
  // OAuth authorization — chat-driven authenticate_oauth.
  [OAUTH_AUTHORIZATION_DECLINED]:
    "the user declined to start the OAuth authorization — do not retry silently; ask the user whether they still want to connect this integration before calling authenticate_oauth again",
  [OAUTH_ELICITATION_TRANSPORT_FAILED]:
    "the MCP elicitation carrying the OAuth authorization URL failed in transit — the authorization state row is still valid, so call authenticate_oauth again for the same connector to resume the existing flow (it will not mint a new URL)",
  [ELICITATION_TRANSPORT_FAILED]:
    "the MCP elicitation request failed in transit (client disconnected or never answered) — the conversation is no longer waiting on input; re-ask the user with an ask_user_* tool only if their answer is still needed",
  [ELICITATION_ALREADY_RESOLVED]:
    "this elicitation was already answered through another channel (a concurrent resume) — do not retry the ask_user_* tool; re-read the conversation state and continue from the answer that already landed",
  [INVALID_ELICIT_RESPONSE]:
    "the MCP client returned an answer that violates the requested schema (an out-of-enum choice or a non-boolean confirm) — this was recorded as a decline; do not silently retry, ask the user again with an ask_user_* tool only if their answer is still needed",
  [OAUTH_TIMEOUT]:
    "the operator did not finish authorizing in time — the authorization is pending, not failed, and the state row is still live; call authenticate_oauth again for the same connector to resume waiting for the existing flow (it will NOT mint a new URL)",
  [OAUTH_AUTHORIZATION_FAILED]:
    "the OAuth provider reported the authorization did not complete — no credential was persisted; call authenticate_oauth again for this connector to start a fresh authorization attempt",
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
