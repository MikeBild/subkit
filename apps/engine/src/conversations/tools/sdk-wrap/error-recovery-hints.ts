import {
  ELICITATION_ALREADY_RESOLVED,
  INVALID_ELICIT_RESPONSE,
  OAUTH_AUTHORIZATION_DECLINED,
  OAUTH_AUTHORIZATION_FAILED,
  OAUTH_ELICITATION_TRANSPORT_FAILED,
  OAUTH_TIMEOUT,
} from "../error-codes.ts";

export const ERROR_CODE_ALTERNATIVES: Readonly<Record<string, string>> = {
  api_key_issuer_unknown:
    "no API key was issued because this conversation has no authenticated issuer. Continue from Cockpit's API access page with the person's signed-in session. Do not retry in this conversation, fabricate an issuer, or use owner_id as a substitute for the issuer.",
  caller_saved_workflow_required:
    "this product identity may run only a saved workflow matching its product. Select an authorized saved workflow; do not submit a draft or standalone step, self-declare a product, or switch tools to bypass the restriction.",
  draft_write_held:
    "the draft probe held an external write before credential lookup or dispatch. Validate the draft with a read-only probe, save the connector, then use call_connector for the exact write with human approval. Do not retry the write through a draft probe or bypass the approval gate.",
  workflow_activation_required:
    "the saved draft is not the active workflow version. Saving did not authorize a live run. This result carries the saved-change review (automation_review): in the cockpit chat it is shown as the review card where the person applies the exact version and allows bounded runs; on a surface without that card, give the person its review_url. Point to it in one short sentence; if the user says the dialog is missing, call review_workflow_automation to show it again. Inspect and preview the draft with inspect_workflow_draft / dry_run_workflow. Never provide an API or REST call, a curl or CLI command, use call_connector against the engine, or say they must leave the chat. Do not run an older active version as a substitute or retry with execute_writes.",
  workflow_version_not_active:
    "the prepared version no longer matches the active workflow version, so nothing ran. Read the current workflow with get_workflow, explain that the prepared version changed, and if the person wants to run the current version, call review_workflow_automation for that exact version and wait for their review. Do not retry with the old expected_workflow_version_id, substitute a different version, or claim the test ran.",
  draft_base_not_observed:
    "this conversation has not observed the workflow's saved draft, so it cannot replace it: either another author saved a draft, or the active version changed since this conversation began. Local edits here are kept. Tell the user in one plain sentence that the prepared change must continue in a new chat opened from the workflow page, where the current saved version is loaded first. A force flag or an old active-version approval cannot stand in for that observation.",
  rewrite_of_bound_workflow:
    "this conversation is bound to a saved workflow, and author_workflow would regenerate the whole definition — dropping every guard the goal does not restate. There is no override. Change it with edit_workflow_patch (step_patches by step_id; add steps at /steps/-; replace a whole step at /steps/N), however many operations that takes. If a patch keeps failing, read the error's own guidance and fix that field — do not switch tools.",
  patch_target_invalid:
    "a step_patches entry named a step_id that does not resolve to exactly one step in the current draft (missing, or duplicated). Nothing was changed. The error names the workflow the draft holds: if you meant another workflow, open it with open_workflow_draft. Otherwise call inspect_workflow_draft to read the real step ids, then re-issue with the exact id — never guess an id or fall back to a numeric position.",
  draft_target_mismatch:
    "the patch was meant for another workflow than the one this conversation's draft holds. Nothing was changed. Open the intended workflow with open_workflow_draft (it starts from the saved definition), then re-issue the patch with that workflow's slug.",
  workflow_already_exists:
    "a saved workflow already has that slug. Do not regenerate it with author_workflow: open it with open_workflow_draft and change it with edit_workflow_patch. Only pick a new slug when the user wants a separate workflow.",
  draft_has_unsaved_changes:
    "the current draft has unsaved changes, so it was not replaced. Save it with save_workflow_draft, or ask the user whether to drop them and then call open_workflow_draft with discard_unsaved:true.",
  authoring_definition_invalid:
    "the generated definition did not validate, so it was not stored and the previous draft is unchanged. Retry author_workflow with a narrower goal, or split the workflow into smaller ones. Do not hand-write the definition piecewise into an unrelated draft.",
  preview_input_unavailable:
    "the preview could not take its input from a saved schedule: the workflow has none enabled in this environment, or more than one, so the engine will not pick for you. Nothing ran. Read them with list_schedules and pass that schedule's saved input explicitly; if there is genuinely none, ask the user for the real values with ask_user_form. Never invent sample values to make a preview pass.",
  draft_conflict:
    "another author changed the saved draft. Preserve local edits, inspect the current saved version, and reconcile the differences before saving. Do not retry blindly or replace the expected version with an unreviewed value.",
  workflow_not_identified:
    "name the workflow you mean — pass `workflow_id` or `slug`. Use find_workflow / list_workflows to get it; do not guess an id.",
  workflow_version_not_found:
    "that workflow has no such version. Read its history with get_workflow and name a version that exists — never probe version numbers until one works.",
  capability_claim_false:
    "you claimed a tool is unavailable that you DO have in this conversation — the abstention was refused. Call the tool. If you already called it and it failed, report what it returned (its error_code and message) instead of describing it as missing.",
  policy_confirm_required:
    "this write paused for approval — nothing ran. A PERSON must approve it (they will see a confirmation in chat, or open the approval link). You cannot approve on their behalf and re-issuing without a human grant only reproduces this pause. Wait for the operator to answer, then continue.",
  approval_not_granted:
    "the approval has not been granted by a person yet — the confirm handle is a trigger, not a grant. Ask the operator to approve (via the chat confirmation or the approval link), and only re-issue once they have. Do not retry in a loop.",
  approval_request_failed:
    "the approval handle could not be opened, so this write cannot be released from the current turn — tell the operator the action must be performed from an authenticated session; do not retry.",
  approval_audit_failed:
    "the confirmation could not be recorded in the audit log, so the write was not performed — a write that cannot be audited is not performed. Re-issue the call to obtain a fresh confirmation.",
  unexpected_gate_decision:
    "an unconfirmed write must pause for human approval and did not resolve to that state, so it was refused rather than run unaudited — do not retry; report that the tool could not be gated.",
  duplicate_pending_elicitation_in_turn:
    "another approval is already pending in this turn — one confirmation at a time. Wait for the operator to answer the outstanding prompt before issuing another write.",
  invalid_arguments:
    "the arguments could not be turned into a call, so nothing was sent and no approval was requested — read the message for the field at fault, correct it, and re-issue. Retrying the same arguments reproduces this.",
  no_connector_in_scope:
    "no connector is in scope — pass an explicit connector_id (find it via find_connector / list_connectors), or run the call from a conversation already bound to a connector",
  no_self_description_link:
    "this connector has no recorded self-description link of that kind yet — run discover_connector_endpoints (with the connector_id) first to detect and record the connector's llms.txt / OpenAPI / GraphQL link, then retry; or search its ingested docs with fetch_connector_docs",
  self_description_fetch_failed:
    "the connector's self-description URL could not be fetched (unreachable, timeout, or non-2xx) — verify the connector's base_url is live and the docs path still exists, then re-run discover_connector_endpoints to refresh the recorded link",
  secret_elicitation_blocked:
    "a secret-shaped value must never be collected as plain chat text over MCP — do NOT re-ask for it with ask_user_text/ask_user_form. Route the operator to the secure credential flow instead: authenticate_oauth or request_connector_reauth starts native URL-mode elicitation so the URL is delivered to the client rather than returned as model text",
  not_available_on_surface:
    "this tool exists in the catalog but cannot be invoked from the current surface — for draft_write tools (save_workflow_draft, dry_run_workflow), the operator must drive the call from a chat conversation, not a headless MCP session",
  principal_required:
    "this tool requires an authenticated principal on the ToolContext — re-issue the call from the HTTP / MCP / sk-cli surface so the auth resolution threads through, instead of invoking the tool directly in-process",
  wrong_reauth_flow:
    "this connector does NOT use a browser authorization-code flow — it is Cognito USER_PASSWORD_AUTH or a client-credentials (M2M) grant, which have no sign-in page. Do not call authenticate_oauth. Call request_connector_reauth instead: it re-collects the credential (email + password, or the M2M secret) in chat and rotates it in place",
  transform_authoring_requires_inspect:
    "the transform references a step with no fingerprint-valid recorded preview (its definition changed since the last preview, or it was never previewed) — call dry_run_workflow ONCE to refresh the evidence, then retry the same edit; unchanged steps keep their evidence, so one dry-run suffices. Read the recorded shape via inspect_workflow_draft or inspect_execution_step(execution_id, step_key, include_full_payload: true) before re-authoring",
  transform_hand_rolled_codec:
    "the transform re-implements a base64 / base32 / hex codec using a hand-rolled alphabet literal or lookup table — use the deterministic sandbox primitives instead: sk.base64Encode, sk.base64UrlEncode, sk.base64EncodeUtf8, sk.base64UrlEncodeUtf8, sk.base64DecodeUtf8, sk.hexEncode, sk.hexDecode. These are FIPS-correct, immune to source-text corruption, and always produce valid output; a hand-rolled encoder can silently emit 'undefined' if its alphabet literal is ever redacted",
  loop_authoring_requires_inspect:
    "the loop's `over`/`data_selector` references a step with no fingerprint-valid recorded preview (its definition changed since the last preview, or it was never previewed) — call dry_run_workflow ONCE to refresh the evidence, then retry the same edit; unchanged steps keep their evidence, so one dry-run suffices. Read the recorded shape via suggest_jsonata_paths or inspect_workflow_draft before re-authoring",
  preview_stale_for_referenced_step:
    "the referenced step's OWN definition changed since its preview was recorded, so the evidence is stale — call dry_run_workflow once to refresh it, then retry the same edit; edits to other steps do NOT invalidate evidence, so this fires only when the step you reference actually changed",
  step_update_invalid:
    'the current draft step is invalid — call inspect_workflow_draft to see the validation errors, then edit_workflow_patch with the corrected fields. Common case: a loop\'s `body` must be an ARRAY of step ids (body: ["step_id"]), never a string and never inline step objects',
  step_invalid:
    "the step shape is wrong — call inspect_workflow_draft for the validation breakdown, then edit_workflow_patch against the failing field",
  unknown_step:
    "the referenced step_id does not exist — call inspect_workflow_draft to list the actual step ids",
  step_not_found:
    "the referenced step did not run in the execution — call inspect_workflow to list step_keys, or run_workflow to produce a fresh execution",
  unresolved_identifier:
    "the JSONata referenced a name not in scope — call suggest_jsonata_paths(workflow_id_or_draft) for the authoritative path list",
  expression_invalid:
    "the JSONata/JS expression is invalid — call suggest_jsonata_paths for available scope keys, then dry_run_transform to validate before saving",
  workflow_unresolved_step_reference:
    "a step referenced an id that doesn't exist — call inspect_workflow_draft to list step ids and edit_workflow_patch to add the missing step or retarget the reference",
  workflow_unsupported_placeholder: `a placeholder used an unsupported binding — the resolver accepts only cred|connector|input|scope|item|state. Inside a loop body: use \${item.<path>} in request strings (path/url/headers/query/body) and $item.<path> in JSONata expressions — bare item names (project.name), \${project.id}, \${user.email}, and Mustache {{…}} are all rejected. Call suggest_jsonata_paths for valid forms, or edit_workflow_patch to replace it`,
  placeholder_unresolved: `a \${…} placeholder did not resolve from scope at runtime — inside a loop body write \${item.<path>} in request strings and $item.<path> in JSONata expressions (never a bare item name); for sibling body steps use \${scope.<body_step_id>.data.<field>}. Verify the path against the recorded preview via inspect_workflow_draft, then re-run dry_run_workflow`,
  workflow_cycle_detected:
    "the workflow has a step-dependency cycle — call inspect_workflow_draft to see the graph, then edit_workflow_patch to remove the cycle",
  workflow_schema_invalid:
    "the workflow schema is invalid — call validate_draft for the field-level errors, then edit_workflow_patch to fix",
  patch_invalid:
    "the patch failed validation — call validate_draft to see the per-field errors, then re-issue edit_workflow_patch with the corrections",
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
    "no runnable workflow yet. If you are AUTHORING a new workflow (the user said build/create/make a workflow), call author_workflow (the one-shot grounded builder) — do NOT call run_workflow again. If a draft already exists, call dry_run_workflow (auto-commits on a clean preview) or save_workflow_draft. Never retry run_workflow with the same args.",
  credential_form_mismatch:
    "the credential form's field names don't match the canonical slots for this auth_type — re-issue ask_user_form using the canonical names (bearer→token; basic→username,password; header→header_name,header_value; query→param,value; signed_jwt→private_key; aws_sigv4→access_key_id,secret_access_key; oauth2→client_id,client_secret); see the `missing` list in the result envelope",
  form_not_renderable:
    "the user's form card cannot show this form, so nobody could answer it — re-issue ask_user_form with 1–100 fields, each with a unique name, a label and a documented field type",
  probe_unchanged:
    "this exact probe already failed and nothing changed since — do NOT re-probe with the same draft. Change the base_url / credential / config via update_connector_draft, or verify the endpoint via fetch_connector_docs / search_docs first",
  connector_secret_not_kept:
    "the draft shows ***redacted*** where the saved connector keeps a secret, and that mask stands for the stored secret only while the draft points where the saved connector does. The host, endpoint or connection string was changed (or the saved connector is gone), so nothing was sent. Either restore the saved destination with update_connector_draft, or collect the real value for the new destination with ask_user_form(sensitive:true). Never type the mask as a value.",
  connector_disabled:
    "the connector is switched off by an operator, so nothing was sent — the same refusal a workflow step on it gets. Do not retry, and do not look for another route to the same system. Tell the user which connector and environment is disabled (see `details`) and that it has to be enabled before it can be called; enabling it is their decision.",
  connector_not_found:
    "the connector id is unknown — call find_connector or list_connectors to discover the correct id",
  connector_has_no_base_url:
    "this connector has no base_url to introspect — pass base_url (the API endpoint) or ingestion_url explicitly to discover_connector_endpoints, or set the connector's base_url first",
  connector_missing:
    "no connector is bound for this operation — call find_connector or start_connector_from_description to create one",
  oauth_requires_template:
    "this oauth2 draft has no template, so its oauth metadata cannot be authored on the draft — call start_connector_from_template with an existing template, or register one via POST /v1/connector-templates (admin); do not retry update_connector_draft with oauth fields",
  auth_param_name_in_config:
    'config has no slot for the query parameter name — for query auth the param name lives in the credential\'s `param` field. Set auth_type:"query" on the draft, then collect the secret via ask_user_form(type:password, sensitive:true) and submit save_connector_draft({credential:{mode:"query", param:"<param-name>", value:"<token>"}}) (e.g. param:"token" for Browserless). Remove the key from config.',
  invalid_connector_draft_edit:
    "the auth edit was refused and not applied — the draft and any key the user already entered are unchanged. Read the listed issues and send a corrected update_connector_draft; do not tell the user their key was lost or ask for it again because of this refusal",
  connector_bindings_missing:
    "the workflow step is missing a connector binding — call inspect_workflow_draft to see required bindings, then edit_workflow_patch to attach a connector",
  connector_bindings_required:
    "this step needs a connector — call find_connector or start_connector_from_description, then edit_workflow_patch to bind it",
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
  sensitive_path:
    "the learning names a key or credential file location and was not saved — restate the learning without naming key, certificate, .env or credential file paths, then call save_learning again",
  intake_items_changed:
    "the confirmed intake items changed or were already decided before the discard ran, so nothing was discarded — call list_intake_items and get_intake_item to read the current state, then ask the person which items to discard",
  snapshot_not_found:
    "the snapshot id is stale or wrong — call list_draft_snapshots to discover the correct id",
  no_snapshot_available:
    "no draft snapshot exists yet — call list_draft_snapshots after the next draft mutation, or author_workflow / edit_workflow_patch to seed one",
  step_not_in_preview:
    "the step did not run in the last preview — call dry_run_workflow or run_workflow first to populate the preview",
  no_preview_recorded:
    "the workflow has no recorded preview — call dry_run_workflow to produce one before reading step results",
  sensitive_execution_unsupported:
    "this workflow carries sensitive execution data, which cannot be placed in conversation previews or messages. Run it through the authenticated executions API and read the result through the owner's execution result endpoint; do not retry it through chat tools",
  preview_empty:
    "the last preview produced no output — call run_workflow with concrete input, or dry_run_workflow with a non-empty input payload",
  connector_auth_unset:
    "the connector draft has no auth_type — call update_connector_draft with the correct auth_type (bearer, basic, api_key, oauth2, or none) before asking for credentials",
  endpoint_not_in_discovered_spec:
    "a request step targets a path the connector's discovered spec does not document — do NOT invent or REST-ify routes; call discover_connector_endpoints (or read the listed nearest routes in the error) and bind each request step to a documented method + path verbatim, encoding the body in the declared media type",
  verifier_rejected:
    "the workflow verifier rejected the change — read the rejection reason and either revise the patch or call ask_user_confirm to confirm an exception",
  repair_loop_detected:
    "three consecutive runs surfaced the same authoring warning — stop, read data-handling.md / workflow-authoring.md, and propose a structurally different draft",
  [OAUTH_AUTHORIZATION_DECLINED]:
    "the user declined to start the OAuth authorization — do not retry silently; ask the user whether they still want to connect this integration before calling authenticate_oauth again",
  [OAUTH_ELICITATION_TRANSPORT_FAILED]:
    "the MCP elicitation carrying the OAuth authorization URL failed in transit — the authorization state row is still valid, so call authenticate_oauth again for the same connector to resume the existing flow (it will not mint a new URL)",
  [ELICITATION_ALREADY_RESOLVED]:
    "this elicitation was already answered through another channel (a concurrent resume) — do not retry the ask_user_* tool; re-read the conversation state and continue from the answer that already landed",
  [INVALID_ELICIT_RESPONSE]:
    "the MCP client returned an answer that violates the requested schema (an out-of-enum choice or a non-boolean confirm) — this was recorded as a decline; do not silently retry, ask the user again with an ask_user_* tool only if their answer is still needed",
  [OAUTH_TIMEOUT]:
    "the operator did not finish authorizing in time — the authorization is pending, not failed, and the state row is still live; call authenticate_oauth again for the same connector to resume waiting for the existing flow (it will NOT mint a new URL)",
  [OAUTH_AUTHORIZATION_FAILED]:
    "the OAuth provider reported the authorization did not complete — no credential was persisted; call authenticate_oauth again for this connector to start a fresh authorization attempt",
};

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
