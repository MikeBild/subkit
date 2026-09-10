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
  draft_write_held:
    "the draft probe held an external write before credential lookup or dispatch. Validate the draft with a read-only probe, save the connector, then use call_connector for the exact write with human approval. Do not retry the write through a draft probe or bypass the approval gate.",
  workflow_activation_required:
    "the saved draft is not the active workflow version. Saving did not authorize a live run. Inspect and preview the draft with inspect_workflow_draft / dry_run_workflow; request human review of the exact version and effects before activation. Do not run an older active version as a substitute or retry with execute_writes.",
  draft_base_not_observed:
    "open the existing workflow in an authoring session to observe its saved draft version before replacing it. Keep local edits; a force flag or an old active-version approval cannot stand in for that observation.",
  draft_conflict:
    "another author changed the saved draft. Preserve local edits, inspect the current saved version, and reconcile the differences before saving. Do not retry blindly or replace the expected version with an unreviewed value.",
  // restore_workflow_version — the recovery tool. Its own failures must not
  // dead-end the recovery: each one names the read that resolves it.
  workflow_not_identified:
    "name the workflow you mean — pass `workflow_id` or `slug`. Use find_workflow / list_workflows to get it; do not guess an id.",
  // `workflow_not_found` is deliberately NOT re-declared here — the existing
  // entry further down already says the right thing, and a second key with the
  // same name would have been silently overwritten by it.
  workflow_version_not_found:
    "that workflow has no such version. Read its history with get_workflow and name a version that exists — never probe version numbers until one works.",
  // The abstention named a tool that IS in this turn's palette. The recovery
  // is never "abstain harder" — it is to use the tool, or to report what it
  // actually returned when it was called.
  capability_claim_false:
    "you claimed a tool is unavailable that you DO have in this conversation — the abstention was refused. Call the tool. If you already called it and it failed, report what it returned (its error_code and message) instead of describing it as missing.",
  // Approval-gate signals — a write paused for HUMAN approval. The model is
  // never the approver: a person grants out of band (chat confirm card or the
  // approval portal link), then the write can be re-issued. Do NOT loop.
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
  // Connector self-description / lazy-fetch signals (fetch_connector_self_description).
  no_connector_in_scope:
    "no connector is in scope — pass an explicit connector_id (find it via find_connector / list_connectors), or run the call from a conversation already bound to a connector",
  no_self_description_link:
    "this connector has no recorded self-description link of that kind yet — run discover_connector_endpoints (with the connector_id) first to detect and record the connector's llms.txt / OpenAPI / GraphQL link, then retry; or search its ingested docs with fetch_connector_docs",
  self_description_fetch_failed:
    "the connector's self-description URL could not be fetched (unreachable, timeout, or non-2xx) — verify the connector's base_url is live and the docs path still exists, then re-run discover_connector_endpoints to refresh the recorded link",
  // Secret hygiene: the model tried to collect a secret-shaped value (api key,
  // token, password) as free chat text over MCP. Route to the secure flow.
  secret_elicitation_blocked:
    "a secret-shaped value must never be collected as plain chat text over MCP — do NOT re-ask for it with ask_user_text/ask_user_form. Route the operator to the secure credential flow instead: authenticate_oauth or request_connector_reauth starts native URL-mode elicitation so the URL is delivered to the client rather than returned as model text",
  // Surface-restriction signals from the unified tool dispatcher.
  not_available_on_surface:
    "this tool exists in the catalog but cannot be invoked from the current surface — for draft_write tools (save_workflow_draft, dry_run_workflow), the operator must drive the call from a chat conversation, not a headless MCP session",
  // Caller bypassed auth: ToolContext arrived without a principal. Production
  // callers always thread it from the auth resolution; a refusal here means
  // an upstream caller dropped the principal. Re-issue via an authenticated
  // surface (HTTP/MCP route, not a raw in-process invocation).
  principal_required:
    "this tool requires an authenticated principal on the ToolContext — re-issue the call from the HTTP / MCP / sk-cli surface so the auth resolution threads through, instead of invoking the tool directly in-process",
  // authenticate_oauth was used on a non-browser grant (Cognito
  // USER_PASSWORD_AUTH or client_credentials_json). Those rotate in chat.
  wrong_reauth_flow:
    "this connector does NOT use a browser authorization-code flow — it is Cognito USER_PASSWORD_AUTH or a client-credentials (M2M) grant, which have no sign-in page. Do not call authenticate_oauth. Call request_connector_reauth instead: it re-collects the credential (email + password, or the M2M secret) in chat and rotates it in place",
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
    "no runnable workflow yet. If you are AUTHORING a new workflow (the user said build/create/make a workflow), call author_workflow (the one-shot grounded builder) — do NOT call run_workflow again. If a draft already exists, call dry_run_workflow (auto-commits on a clean preview) or save_workflow_draft. Never retry run_workflow with the same args.",
  credential_form_mismatch:
    "the credential form's field names don't match the canonical slots for this auth_type — re-issue ask_user_form using the canonical names (bearer→token; basic→username,password; header→header_name,header_value; query→param,value; aws_sigv4→access_key_id,secret_access_key; oauth2→client_id,client_secret); see the `missing` list in the result envelope",
  probe_unchanged:
    "this exact probe already failed and nothing changed since — do NOT re-probe with the same draft. Change the base_url / credential / config via update_connector_draft, or verify the endpoint via fetch_connector_docs / search_docs first",
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
  snapshot_not_found:
    "the snapshot id is stale or wrong — call list_draft_snapshots to discover the correct id",
  no_snapshot_available:
    "no draft snapshot exists yet — call list_draft_snapshots after the next draft mutation, or author_workflow / edit_workflow_patch to seed one",
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
  // Endpoint grounding — request steps must target a discovered route.
  endpoint_not_in_discovered_spec:
    "a request step targets a path the connector's discovered spec does not document — do NOT invent or REST-ify routes; call discover_connector_endpoints (or read the listed nearest routes in the error) and bind each request step to a documented method + path verbatim, encoding the body in the declared media type",
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
