import type { ManifestIssueCode } from "./effect-manifest.ts";
import type { GateDiagnosis, GateDiagnosisCode, WorkflowDiagnosis } from "./gate-diagnosis.ts";
import { GRAPHQL_OVER_HTTP_REPAIR, GRAPHQL_OVER_HTTP_WARNING } from "./graphql-conversion.ts";
import type { RequestBoundaryRefusal } from "./request-boundary.ts";
import type { StorageBoundaryRefusal } from "./storage-boundary.ts";

type Driver =
  | "http"
  | "graphql"
  | "postgres"
  | "s3"
  | "sftp"
  | "mcp"
  | "local_files"
  | "local_browser"
  | "local_computer";

const GMAIL_SEND_TARGET = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

const PROPOSED_LIMITS_FIRST =
  "SubKit can derive this limit from what the step really did: on the workflow page the status " +
  "line offers **Set limits**, which lists the suggested limit for review, applies it to a new " +
  "draft and, for a step that never ran, starts a trial run that holds back every write. Point " +
  "the person there first. Author it by hand only when that dialog has nothing to suggest for " +
  "this step or the person asks you to. ";

const STORAGE_SCOPE_REMEDY =
  PROPOSED_LIMITS_FIRST +
  "Author a fixed folder boundary on this step: add `s3.scope` with `key_prefix` (a narrow " +
  "existing folder ending in `/`) and `max_bytes`, plus `max_deletes` when the step removes " +
  "objects — a DELETE is eligible only with `max_deletes`. Patch it with `edit_workflow_patch` " +
  '`step_patches: [{step_id, op: "add", path: "/s3/scope", value: {…}}]`. Do NOT template ' +
  "`s3.max_keys` or `s3.paginate`: both are derived by the engine from the step and are not " +
  "author-set per-prefix limits. If one prefix cannot cover every key the step touches, split " +
  "the step into narrower per-folder steps rather than widening the prefix.";

const STORAGE_REFUSAL_REMEDY: Partial<Record<StorageBoundaryRefusal, string>> = {
  delete_with_body:
    "This step already has `s3.scope`; the folder boundary is refused because the DELETE carries a " +
    "`body`. There is no bulk-delete shape: the driver ignores a DELETE body and removes the single " +
    "object named by `s3.key`. Remove `body`, set `s3.key` to the object key (for example " +
    "`${item.key}`), and iterate one request per object with a JavaScript selector, for example " +
    '`for_each: "(sourceData) => sourceData.<list_step_id>.data.items"` — not a placeholder and ' +
    "not a JSONata reference.",
  query_or_headers_present:
    "This step already has `s3.scope`; the folder boundary is refused because the step sets " +
    "`query` or `headers`. A bounded storage request sends neither — remove both fields.",
  runtime_value_outside_key:
    "This step already has `s3.scope`; the folder boundary is refused because a runtime " +
    "placeholder appears outside `s3.key` / `s3.prefix` (and `body` for a PUT). Only the object " +
    "key, the list prefix and the written content may vary; every other field must be a literal.",
  unsupported_option:
    "This step already has `s3.scope`; the folder boundary is refused because it uses an option " +
    "the recurring profile does not support (pagination block, multipart, xml, metadata, range, " +
    "presign). Remove that option.",
  content_type_invalid:
    "This step already has `s3.scope`; the folder boundary is refused because `s3.content_type` is " +
    "only allowed on PUT (and must not contain line breaks). Remove it from this step.",
  scope_invalid:
    "This step's `s3.scope` does not parse: `key_prefix` must be a literal folder of at least three " +
    "characters ending in `/` with no `.`/`..` segments and no placeholder, `max_bytes` a positive " +
    "integer up to 10000000, and a DELETE additionally needs `max_deletes` (1 to 10000).",
  unsupported_method: "Only GET, HEAD, LIST, PUT and DELETE can be bounded by a storage folder.",
};

const REQUEST_BOUNDARY_REMEDY =
  PROPOSED_LIMITS_FIRST +
  'Patch ONLY this step: `edit_workflow_patch` `step_patches: [{step_id, op: "add", path: ' +
  '"/boundary", value: {variables, max_body_bytes, max_calls}}]`. Do not re-author the workflow ' +
  "and do not change `path`, `query`, `body` or `for_each`. `boundary` sits directly on the step " +
  "beside `method` — not under `s3`, `config` or `body`. `variables` has exactly one entry per " +
  "`${…}` that is a whole segment of `path` or a whole value in `query`, keyed by the expression " +
  'WITHOUT the `${}` (for example `"input.site_id"`, `"item.slug"`, `"scope.window.data.start"`); ' +
  "use `{}` when neither varies. Each entry is `{enum: [every allowed value]}` — for `input.*` " +
  "copy the value from the saved schedule input (`list_schedules`), for `item.*` list every value " +
  'the `for_each` source can yield. Only when the values CANNOT be listed use `{class: "…"}`: ' +
  "`uuid` or `integer` or `identifier` for an id that comes from an earlier step, `date` " +
  "(YYYY-MM-DD) or `timestamp` (UTC text ending in Z) for a time window — a window given as unix " +
  "seconds is `integer`; read the real value in the last run before choosing. A class approves every value " +
  "of that form, so never use one where a list is possible, and never on a DELETE. Placeholders " +
  "in the body need no entry. `max_body_bytes` is the largest UTF-8 body this step may send (0 for GET/HEAD): size " +
  "it from the workflow's own limits (for example its batch cap times the bytes per item, plus " +
  "the fixed fields), never from a guess — a preview whose request does not fit fails with " +
  "`request_outside_declared_boundary` and names both numbers; " +
  "`max_calls` is the most requests per run (1 without `for_each`). A DELETE also needs " +
  "`destructive: true`. An enum value is written exactly as it is sent and may contain `:` and " +
  "`%XX` escapes (for example `123:runReport` or `https%3A%2F%2Fexample.com%2F`). Not coverable " +
  "as written: a placeholder that is only PART of a path segment or of a query value — build the " +
  "whole value in a transform and reference that instead. Percent-encoding is NOT a way around " +
  "the one-segment rule: `%2F` is not a `/` to the server, so a value like `a%2Fb` addresses " +
  "something else and the request goes nowhere. One placeholder per segment, always. A header " +
  'value that is one whole placeholder (`"Idempotency-Key": "${input.body.workId}"`) is bounded ' +
  'by `boundary.headers`, keyed by the literal header name: `{"Idempotency-Key": {class: ' +
  '"identifier"}}`. Not coverable at all yet: a header NAME or a query KEY that varies, and ' +
  "`pagination`.";

const REQUEST_REFUSAL_REMEDY: Partial<Record<RequestBoundaryRefusal, string>> = {
  variables_mismatch:
    "This step already has `boundary`, but `boundary.variables` does not match the step: it needs " +
    "exactly one entry per `${…}` that is a whole segment of `path` or a whole value in `query`, " +
    "keyed by the expression without the `${}`, and NO entry for anything else. A placeholder that " +
    "appears only in the body gets no entry — remove it from `variables`; the body is limited by " +
    "`max_body_bytes` alone.",
  boundary_invalid:
    "This step already has `boundary`, but it does not parse: `variables` maps an expression such " +
    'as `"input.site"` to `{enum: [...]}` (1 to 50 values of letters, digits, `.`, `_`, `~`, `-`, ' +
    '`:` and `%XX` escapes, exactly as sent) or to `{class: "identifier" | "uuid" | "integer" | "date" | "timestamp"}`, never both, and `caller.subject` or `caller.principalId` to `{caller_bound: true}`; ' +
    "`max_body_bytes` is an integer from 0 to 10000000; `max_calls` an integer from 1 to " +
    "10000; `destructive` may only be `true`. No other keys.",
  delete_requires_destructive:
    "This step already has `boundary`; a DELETE additionally needs `destructive: true` inside it, so " +
    "a removal is never approved by omission.",
  delete_requires_enum:
    "This step already has `boundary`, but a DELETE may only vary over listed values or the " +
    "authenticated caller: replace each `{class: …}` with `{enum: [every value that may be " +
    "removed]}`, or address the caller's own record with `${caller.subject}` or " +
    "`${caller.principalId}` and the rule `{caller_bound: true}`, or remove an id an earlier step " +
    "of this workflow created: record it with `records_created: {id_path}` on that step and give " +
    "the DELETE placeholder `{created_by_workflow: true}`. A removal of anything that merely looks " +
    "like an id is not something a human can approve.",
  created_by_workflow_misplaced:
    "`{created_by_workflow: true}` belongs only on the LAST segment of a DELETE `path` whose other " +
    "segments are fixed, on a step with `connector_id` and `destructive: true`, and only once per " +
    "step. The id must come from a POST or PUT of this workflow to exactly that fixed collection " +
    "path on the same connector that records it with `records_created: {id_path}`; use " +
    "`{enum: [...]}` for any other value.",
  caller_bound_mismatch:
    "This step already has `boundary`, but its caller rules disagree: `caller.subject` and " +
    "`caller.principalId` take exactly `{caller_bound: true}`, and no other variable may use it.",
  partial_segment_placeholder:
    "`boundary` cannot cover this step as written: a placeholder is only PART of a path segment " +
    "(text before or after it between two `/`), several segments hide in one placeholder, or its " +
    "root is not `input`, `scope` or `item`. Only a placeholder that is one WHOLE segment can be " +
    "bounded. Re-author minimally: have a transform (or the step that builds the `for_each` items) " +
    'produce each whole segment as its own value — for `{id}:action` the full `"123:action"`, for a ' +
    "multi-segment path one value per segment — reference each as its own whole-segment " +
    "placeholder, and list the full values in `enum` (a `:` and `%XX` escapes are allowed in a " +
    "value). Change nothing else in the step.",
  query_placeholder_unsupported:
    "`boundary` cannot cover this step as written: a `query` value mixes text with a placeholder, " +
    "is not a plain string, or names a root other than `input`, `scope` or `item`. Only a query " +
    'value that is one whole placeholder (`"${scope.window.data.start}"`) can be bounded, with an ' +
    "entry of its own in `boundary.variables`. Build the full value in a transform first if text " +
    'has to surround it. A value made only of vault handles (`"${secret.crm-token}"`) needs no ' +
    "entry: the approval names the vault item.",
  runtime_header:
    "`boundary` cannot cover this step: a header name holds a placeholder, or a header value is a " +
    "runtime placeholder that is not one whole `${input.*}`, `${scope.*}` or `${item.*}`. Keep the " +
    "name literal, build the whole value in a transform first, and bound it with an entry in " +
    '`boundary.headers` keyed by the header name, such as `{"Idempotency-Key": {class: ' +
    '"identifier"}}`. Otherwise make the header a literal or leave this step to concrete-run review.',
  header_boundary_mismatch:
    "This step already has `boundary`, but `boundary.headers` does not match the step: it needs " +
    "exactly one entry per header whose value is a runtime placeholder bounded there, keyed by the " +
    "header name as the step sends it, and NO entry for a header that is literal, holds only " +
    "vault handles or is not sent. Remove the extra entry or add the missing one; do not change " +
    "the header itself.",
  runtime_value_outside_path_and_body:
    "This step has a runtime placeholder in a field the engine substitutes and that a boundary " +
    "cannot hold: only the path (whole segments), whole query values and the body may vary. Make " +
    "that field a literal. This does NOT mean `for_each` or `data_selector`: those carry " +
    "JavaScript the sandbox evaluates, a `${…}` in them is a template literal, and they are not " +
    "checked — never rewrite a selector to satisfy this.",
  path_unsupported:
    "`boundary` needs exactly one of `path` or `url`, without `?`, `#`, `%` or `\\`. Move query " +
    "parameters into the step's `query` object.",
  pagination_unsupported:
    "`boundary` cannot cover this paginated step: it sends a multipart body, or a paging " +
    "parameter has no name. A multipart upload cannot be paged under a boundary; split the " +
    "read into its own step. Otherwise give every paging parameter a name.",
  pagination_body_unsupported:
    'This step pages through the request body (`parameter_location: "body"`), and `boundary` ' +
    "covers that only when the paging fields are top-level fields of a JSON object body on a " +
    "method that carries one. Use POST, PUT or PATCH, and make `body` a JSON object (or omit " +
    "it) whose own keys are literals — not a string, a list, or one placeholder for the whole " +
    "body. Every later page must equal the first except for the paging fields, and " +
    "`pagination.max_pages` is the most pages one run may read.",
  pagination_unbounded:
    "This step paginates without `max_pages`, so the number of requests it makes is not a number " +
    "anyone can review. When the step has run before, **Set limits** on the workflow page " +
    "suggests the ceiling from the pages it really fetched. Otherwise set " +
    "`pagination.max_pages` to the most pages one run may read.",
  pagination_param_conflict:
    "A paging parameter is also one of this step's own query keys — or, when the step pages " +
    "through the body, one of the body's own top-level fields — which would give one value two " +
    "rules. Rename the paging parameter, or drop that key from `query` or `body`.",
  variable_in_base_prefix:
    "This step already has `boundary`, but a path placeholder sits where the connector's base path " +
    "is matched, so a runtime value would decide how the URL is assembled. The path has to START " +
    "with literal segments. If the placeholder stands for the WHOLE path or for several segments " +
    "at once, one value per segment is needed: have the transform that builds it return each " +
    "segment separately (for `/billing/do:team:<uuid>/insights/<from>/<to>` that is an account " +
    "value, a from and a to), write the path with the literals in place and one placeholder per " +
    "segment (`/billing/${item.account}/insights/${item.from}/${item.to}`), and give each one its " +
    "own rule. A value may contain `:`, so `do:team:<uuid>` is one legal enum value; a value may " +
    "NOT contain `/`.",
  enum_value_unroutable:
    "This step already has `boundary`, but one of its `enum` values does not reach the reviewed " +
    "target. The usual cause is a value that stands for more than one segment: a `/` cannot be " +
    "smuggled in as `%2F`, because the server reads `%2F` as a literal character and not as a " +
    "separator — such a request addresses something that does not exist. Split the path so that " +
    "each segment has its own placeholder and its own rule, and use the exact identifier the API " +
    "expects. A `:` inside one segment is fine (`123:runReport`).",
  target_unresolved:
    "The request target cannot be resolved: the connector has no base URL and the path is not an " +
    "absolute http(s) URL, or the target carries credentials or a fragment.",
  connector_query_conflict:
    "This step's connector appends query parameters of its own (query-mode authentication or a " +
    "static query), and they are reviewed as part of the address. One of them has the same name " +
    "as a key in this step's `query` or as a paging parameter, so one key would have two rules. " +
    "Remove that key from the step's `query` — the connector already sends it — or rename the " +
    "paging parameter.",
  connector_query_needs_boundary:
    "This read varies its path or query at run time, and its connector appends query parameters " +
    "of its own (query-mode authentication or a static query). Without `boundary` such a read is " +
    "checked against its exact authored query, so every run would be refused. Add `boundary` to " +
    "this step: the connector's own parameters are then reviewed as part of the address. " +
    REQUEST_BOUNDARY_REMEDY,
  connector_query_unresolved:
    "This step's connector appends query parameters of its own, and the engine could not read " +
    "which ones: the connector's `static_query` is not a flat map of text values, or its " +
    "query-mode credential is missing or unreadable. Nothing on the step fixes this. The " +
    "connector needs a working credential (or a corrected `static_query`); then review again.",
  stricter_profile_applies:
    "Do not add `boundary` here: this step is a report e-mail or a content publication, which has " +
    "its own stricter review of the recipient or the published items.",
  report_delivery_unprepared:
    "This report e-mail has its own stricter review, and nothing has observed it yet: no " +
    "preparation run exists for this version in this environment. Let one run — it holds every " +
    "write, so nothing is sent — and the recipient it resolves to becomes the reviewed boundary.",
  report_delivery_unobserved:
    "A preparation run reached this step but recorded no usable recipient, so there is nothing to " +
    "review. Inspect that run's step: an unresolved placeholder or a body the profile cannot read " +
    "leaves no observation behind. Do not add `boundary` — it is not a way around this review.",
  report_delivery_unreachable:
    "A preparation run exists but never reached this step, so no recipient was observed. Another " +
    "preparation will not help if the step sits behind a condition that depends on a write a " +
    "preparation holds back — a held run can never observe a step whose reachability it suppresses. " +
    'Declare the recipient on the step instead: `report_delivery: {kind: "gmail_report", to, from, ' +
    "content_type}`. A human approves that statement and the runtime still decodes the real message " +
    "and compares the recipient byte for byte, so a declaration that does not match is refused at " +
    "the wire. The alternative is to make the branch reachable without the held write. When the " +
    "recipient changes every run because an earlier fixed GET step reads it from a queue, declare " +
    "`outbox_delivery` instead (skill workflow-authoring-transactional-mail); a fixed " +
    "`report_delivery` would send every message to that one address.",
  report_delivery_contradicted:
    "This step declares its recipient in `report_delivery`, and a preparation of this very " +
    "version reached the step with a message that contradicts it: either the message is outside " +
    "the report profile, or it is addressed to a different recipient, from a different sender, or " +
    "in a different content type. Every run would be refused at the wire. The held step's " +
    "`report_delivery_inspection` names the reason. Repair the MESSAGE when the declaration is " +
    "right — build it with sk.buildMimeMessage, or encode hand-built MIME with " +
    "sk.base64UrlEncodeUtf8 rather than sk.base64UrlEncode. Correct the DECLARATION only when it " +
    "is the declaration that is wrong (sk.buildMimeMessage with both html and text produces " +
    "`multipart/alternative`). Do not remove the declaration to get past this, and do not add " +
    "`boundary`. Save, let a preparation run, and recheck.",
  not_http_step:
    "`boundary` applies to plain HTTP request steps only. A storage step is bounded with " +
    "`s3.scope` and an MCP tool call with `mcp.boundary`; SQL, GraphQL, XML and multipart steps " +
    "cannot be bounded yet.",
};

const MCP_BOUNDARY_REMEDY =
  "An MCP tool call is approvable only with `mcp.boundary` on the step, beside `mcp.tool`: " +
  "`{effect, variables, max_calls, descriptor}`. `mcp.tool` must be the literal tool name, with " +
  "no `${…}`. Inside `mcp.arguments` a runtime value must be one WHOLE placeholder per value " +
  '(`"${input.query}"`, never text around it and never in a key); every other argument is a ' +
  "literal. `variables` has exactly one entry per such placeholder, keyed by the expression " +
  "without `${}`, each `{enum: [every allowed value]}`, `{class: identifier|uuid|integer|date|" +
  "timestamp|timestamp_range|file_name}`, or `{caller_bound: true}` for `caller.subject` / " +
  "`caller.principalId`; use `{}` when nothing varies. `max_calls` is the most calls one run " +
  'may make (1 without `for_each`). `effect` is what the call does, `"read"` or `"write"`, as ' +
  "the person approving will read it; leave it out and it counts as a write, and never state " +
  "`read` for a tool that changes anything. `descriptor` pins the tool as the server lists it " +
  "now: copy `boundary_descriptor` of that tool from `POST /v1/connectors/{id}/mcp/inspect` " +
  "unchanged — do not invent the digest or the annotations; the review compares the pin with " +
  "the server and refuses a mismatch. A call stated as `write` (or with no stated effect) also " +
  "needs `max_retries: 0` on the step, because a retry could repeat the write. Before every call the engine compares the server's current " +
  "description of the tool with this pin; when the server changes the tool, the run is refused " +
  "and a person reviews again. No placeholder may sit anywhere else on the step. Only " +
  "`call_tool` can be bounded; a `read_resource` or `get_prompt` step cannot be approved for " +
  "repeated runs yet.";

const GMAIL_REPORT_REMEDY =
  "A reviewed report boundary is not available yet; this alone does NOT establish malformed MIME. " +
  "First inspect the exact-version preview: did this email step materialize, or was it skipped " +
  "because an upstream request was held or failed? Repair the evidenced upstream cause before " +
  "changing email construction. When the step was held, its `report_delivery_inspection` names " +
  "the rule the message broke (`not_utf8`, `header_control_byte`, `extra_recipients`, …) — start " +
  "there. Build the message with sk.buildMimeMessage({from, to, subject, html, text}); it " +
  "produces exactly what the review accepts: ONE sender and ONE recipient, each `addr` or " +
  "`Name <addr>` (a name of plain ASCII words and spaces — no quotes, comments, `:` `;` `@` " +
  "`,` `.` or other punctuation that structures an address; only the address is compared), a " +
  "Unicode subject, and a text/html or text/plain body or both as multipart/alternative. If a " +
  "transform assembles MIME itself, it needs From, To, Subject, MIME-Version: 1.0 and " +
  "Content-Type, unfolded, and it must be encoded with sk.base64UrlEncodeUtf8, never " +
  "sk.base64UrlEncode: the latter keeps one byte per character, so `·` becomes a byte that is " +
  "not UTF-8 (`not_utf8`) and `—` a control byte (`header_control_byte`). Cc, Bcc, Reply-To, " +
  "custom headers, attachments and a second recipient stay outside this review. Changing report " +
  "content IS supported. Keep method POST and endpoint fixed. Set body to an object with only " +
  "raw, whose VALUE may be a dynamic reference to the encoded message. Do not infer recipients " +
  "from transform source code: review checks the materialized message. Do not replace report " +
  "content with a constant. Save the repaired draft, open the real review card to prepare its " +
  "held preview, and recheck eligibility. No message is sent by that preparation.";

const REMEDIES: Partial<Record<ManifestIssueCode, Partial<Record<Driver, string>>>> = {
  dynamic_request: {
    s3: STORAGE_SCOPE_REMEDY,
    http: REQUEST_BOUNDARY_REMEDY,
    mcp: MCP_BOUNDARY_REMEDY,
  },
  destructive_effect: {
    s3: STORAGE_SCOPE_REMEDY,
  },
  unknown_effect: {
    mcp: MCP_BOUNDARY_REMEDY,
  },
};

const DRIVERLESS_REMEDIES: Partial<Record<ManifestIssueCode, string>> = {
  missing_binding:
    "This step names a connector that does not resolve in this workspace and environment: it " +
    "was deleted, or it never existed here. Nothing can be approved for a step whose target is " +
    "unknown. `diagnose_workflow` names what is missing in `evidence.binding`: the kind, the " +
    "referenced connector, whether it was deleted, and a live connector with the same slug and " +
    "driver when one exists. Repair: point the step's `connector_id` at that live connector " +
    "(or at another live connector of the same driver for this environment), or restore the " +
    "deleted connector, then save and review again. Do not remove the step to get past the " +
    "gate, and do not add `boundary`: it does not stand in for a connector.",
  binding_mismatch:
    "The step does not match the connector it resolves to: its kind (a `graphql`, `sql`, `mcp` " +
    "or `s3` block, or plain HTTP) must match the connector's driver, and the step must not have " +
    "changed since its binding was resolved. A `graphql` block on an http connector is " +
    'supported only with a fixed same-host `path` such as "/graphql" and without `url`. ' +
    `${GRAPHQL_OVER_HTTP_REPAIR} ${GRAPHQL_OVER_HTTP_WARNING} ` +
    "Otherwise inspect the draft again and review the current version.",
  boundary_contradicted_by_history:
    "The folder this step declares does not contain a key the step itself has already written. " +
    "This is not a guess and not a preview artefact: the key comes from a successful run of this " +
    "very step, and the review names it. Set `s3.scope.key_prefix` to the folder that key is " +
    "actually in — usually the step was given the folder of a neighbouring step that writes " +
    "something else. Do NOT widen the folder to cover both, do not remove the boundary, and do " +
    "not change what the step writes to match the wrong folder: the key is correct and the " +
    "declaration is not. A write is held in every preview, so this is the only point before a " +
    "scheduled run where the mismatch can be seen at all.",
  unbound_workflow_call:
    "This step starts another workflow, and the approval could not be extended to cover it. " +
    "Which is why decides what to do, and `review_workflow_automation` names the reason for " +
    "this step. `child_unavailable`: the workflow it names is archived, deleted, or not in " +
    "this workspace — point the step at a live one. `target_not_static`: the step must name " +
    "exactly ONE fixed workflow, by `workflow_id` or by `workflow_slug` and not both, with no " +
    "placeholder in it, because which workflow runs may not change between the approval and " +
    "the run. `child_calls_workflow`: the workflow it starts itself starts another — approving " +
    "that would approve a chain whose far end nobody reviewed; flatten the middle workflow or " +
    "give the innermost one its own schedule and its own approval. `boundary` and `s3.scope` " +
    "do nothing on a call step. Do not offer a one-off run as a substitute for recurring " +
    "approval, and if the call passes no `input` and no later step reads its result, removing " +
    "the call and scheduling the child on its own is the simpler answer.",
};

export function calledWorkflowPrefix(call_step_id: string, workflow_slug: string | null): string {
  return (
    `This step is inside the called workflow \`${workflow_slug ?? "it starts"}\` (started by ` +
    `step \`${call_step_id}\`). Repair it THERE, in that workflow's own chat; nothing in this ` +
    "workflow can change it. After the child is saved and activated, review this workflow again. "
  );
}
export function remedyFor(
  code: ManifestIssueCode,
  driver: Driver | null | undefined,
  target?: string | null,
): string | null {
  if (code === "dynamic_request" && driver === "http" && target === GMAIL_SEND_TARGET)
    return GMAIL_REPORT_REMEDY;
  const driverless = DRIVERLESS_REMEDIES[code];
  if (driverless) return driverless;
  if (!driver) return null;
  return REMEDIES[code]?.[driver] ?? null;
}

interface RepairGuidance {
  step_id: string;
  code: GateDiagnosisCode;
  instruction: string;
  reason?: GateDiagnosis["reason"];
  remedy_kind?: GateDiagnosis["remedy_kind"];
  fixer?: GateDiagnosis["fixer"];
  candidate_id?: string;
}

const FIXER_REMEDY: Record<NonNullable<GateDiagnosis["fixer"]>, string> = {
  use_utf8_encoder:
    "The report message is encoded one byte per character, so a non-ASCII character in it is " +
    "not UTF-8 and the gate refuses the message. A deterministic repair exists: " +
    "`propose_workflow_repair` with this `step_id` and `fixer` files the change " +
    "(`sk.base64UrlEncode(` becomes `sk.base64UrlEncodeUtf8(` in the transform that builds the " +
    "message) as a patch candidate a person reviews. Do not hand-edit the encoder in parallel.",
  declare_report_delivery:
    "No preparation can observe this report step on this version, or its declaration " +
    "contradicts what was observed. A deterministic repair exists: `propose_workflow_repair` " +
    "with this `step_id` and `fixer` files a declaration copied from a recorded successful " +
    "inspection of this step, as a patch candidate a person reviews.",
};

const DRAFT_FIXER_REMEDY: Record<NonNullable<GateDiagnosis["fixer"]>, string> = {
  use_utf8_encoder:
    "The report message is encoded one byte per character, so a non-ASCII character in it is " +
    "not UTF-8 and the gate refuses the message. This diagnosis is of the saved draft, not the " +
    "active version, so no repair can be proposed for it. Fix it in the draft: in the transform " +
    "that builds the message, replace `sk.base64UrlEncode(` with `sk.base64UrlEncodeUtf8(`, " +
    "save, and review again. Or apply the draft and diagnose the active version again.",
  declare_report_delivery:
    "No preparation can observe this report step on this version, or its declaration " +
    "contradicts what was observed. This diagnosis is of the saved draft, not the active " +
    "version, so no repair can be proposed for it. Fix it in the draft: set the step's " +
    "`report_delivery` to the addresses a successful preparation of this draft observed " +
    "(diagnose_workflow's `evidence.observed`), save, and review again. Or apply the draft and " +
    "diagnose the active version again.",
};

export function repairGuidanceForIssues(
  issues: ReadonlyArray<{ step_id: string; code: ManifestIssueCode }>,
  effects: ReadonlyArray<{ step_id: string; driver: Driver; target: string | null }>,
  storageRefusals: ReadonlyArray<{ step_id: string; reason: StorageBoundaryRefusal }> = [],
  requestRefusals: ReadonlyArray<{ step_id: string; reason: RequestBoundaryRefusal }> = [],
  diagnosis: Pick<WorkflowDiagnosis, "is_current" | "diagnoses"> | null = null,
): RepairGuidance[] {
  const diagnoses = diagnosis?.diagnoses ?? [];
  const proposable = diagnosis?.is_current === true;
  const fixerRemedy = proposable ? FIXER_REMEDY : DRAFT_FIXER_REMEDY;
  const byStep = new Map(effects.map((effect) => [effect.step_id, effect]));
  const refusalByStep = new Map(storageRefusals.map((entry) => [entry.step_id, entry.reason]));
  const requestRefusalByStep = new Map(
    requestRefusals.map((entry) => [entry.step_id, entry.reason]),
  );
  const seen = new Set<string>();
  const joined = new Set<GateDiagnosis>();
  const guidance: RepairGuidance[] = [];
  for (const issue of issues) {
    const effect = byStep.get(issue.step_id);
    const refusal = refusalByStep.get(issue.step_id);
    const requestRefusal = requestRefusalByStep.get(issue.step_id);
    const matched = diagnosisFor(diagnoses, issue.step_id, [issue.code, requestRefusal, refusal]);
    const instruction =
      (matched?.fixer ? fixerRemedy[matched.fixer] : undefined) ??
      (effect?.driver === "s3" && refusal ? STORAGE_REFUSAL_REMEDY[refusal] : undefined) ??
      (effect?.driver === "http" && requestRefusal
        ? REQUEST_REFUSAL_REMEDY[requestRefusal]
        : undefined) ??
      remedyFor(issue.code, effect?.driver, effect?.target);
    if (!instruction) continue;
    const key = `${issue.step_id}:${issue.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (matched) joined.add(matched);
    guidance.push({
      step_id: issue.step_id,
      code: issue.code,
      instruction,
      ...diagnosisFields(matched, proposable),
    });
  }
  for (const entry of diagnoses) {
    if (!entry.fixer || joined.has(entry)) continue;
    guidance.push({
      step_id: entry.subject.step_id,
      code: entry.code,
      instruction: fixerRemedy[entry.fixer],
      ...diagnosisFields(entry, proposable),
    });
  }
  return guidance;
}

function diagnosisFor(
  diagnoses: ReadonlyArray<GateDiagnosis>,
  step_id: string,
  codes: ReadonlyArray<string | undefined>,
): GateDiagnosis | undefined {
  const ofStep = diagnoses.filter((entry) => entry.subject.step_id === step_id);
  return ofStep.find((entry) => codes.includes(entry.code)) ?? ofStep.find((entry) => entry.fixer);
}

function diagnosisFields(diagnosis: GateDiagnosis | undefined, proposable: boolean) {
  if (!diagnosis) return {};
  return {
    ...(diagnosis.reason ? { reason: diagnosis.reason } : {}),
    remedy_kind: diagnosis.remedy_kind,
    ...(proposable && diagnosis.fixer ? { fixer: diagnosis.fixer } : {}),
    ...(proposable && diagnosis.candidate_id ? { candidate_id: diagnosis.candidate_id } : {}),
  };
}
