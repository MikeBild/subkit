// What to DO about a manifest issue.
//
// `ManifestIssueCode` names what is wrong. On its own it is a token: a reader —
// human or model — is left to infer the fix from prose somewhere else. That gap
// is not theoretical. Asked to bound a retention workflow's removals, the
// authoring model diagnosed `dynamic_request` correctly and then invented a
// remedy out of `s3.max_keys`, a field that exists but is DERIVED from the step
// rather than authored. It never reached for `s3.scope`, because nothing it was
// holding connected the code to the field.
//
// So the remedy travels with the diagnosis. This table is the one place that
// mapping lives, in `workflows/` so the scheduler, the conversation tools and
// the cockpit can share it without a layering inversion.
//
// Text is written for whoever has to act: it names the exact field, the patch
// shape, and the traps that produced real mistakes. It deliberately does NOT
// say "explain this to the user" — it is a tool-result string, and the skills
// own the conversation.

import type { ManifestIssueCode } from "./effect-manifest.ts";
import type { RequestBoundaryRefusal } from "./request-boundary.ts";
import type { StorageBoundaryRefusal } from "./storage-boundary.ts";

type Driver = "http" | "graphql" | "postgres" | "s3" | "mcp";

/** The one fixed target whose report profile has its own long-standing remedy. */
const GMAIL_SEND_TARGET = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";

const STORAGE_SCOPE_REMEDY =
  "Author a fixed folder boundary on this step: add `s3.scope` with `key_prefix` (a narrow " +
  "existing folder ending in `/`) and `max_bytes`, plus `max_deletes` when the step removes " +
  "objects — a DELETE is eligible only with `max_deletes`. Patch it with `edit_workflow_patch` " +
  '`step_patches: [{step_id, op: "add", path: "/s3/scope", value: {…}}]`. Do NOT template ' +
  "`s3.max_keys` or `s3.paginate`: both are derived by the engine from the step and are not " +
  "author-set per-prefix limits. If one prefix cannot cover every key the step touches, split " +
  "the step into narrower per-folder steps rather than widening the prefix.";

/**
 * A storage step that ALREADY declares `s3.scope` and still compiled no
 * boundary. Telling its author to "add s3.scope" again is worse than saying
 * nothing: it is confidently wrong, and a repair loop forms around it. Each
 * refusal names the one thing to change.
 */
const STORAGE_REFUSAL_REMEDY: Partial<Record<StorageBoundaryRefusal, string>> = {
  delete_with_body:
    "This step already has `s3.scope`; the folder boundary is refused because the DELETE carries a " +
    "`body`. There is no bulk-delete shape: the driver ignores a DELETE body and removes the single " +
    "object named by `s3.key`. Remove `body`, set `s3.key` to the object key (for example " +
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shows the literal authored placeholder
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

/**
 * The general remedy for an HTTP step with a runtime placeholder. Written so a
 * reader holding ONLY this string can author the boundary: past repairs invented
 * fields from the wrong layer, guessed selector syntax, and re-authored whole
 * workflows instead of patching one step.
 */
const REQUEST_BOUNDARY_REMEDY =
  'Patch ONLY this step: `edit_workflow_patch` `step_patches: [{step_id, op: "add", path: ' +
  '"/boundary", value: {variables, max_body_bytes, max_calls}}]`. Do not re-author the workflow ' +
  "and do not change `path`, `query`, `body` or `for_each`. `boundary` sits directly on the step " +
  "beside `method` — not under `s3`, `config` or `body`. `variables` has exactly one entry per " +
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shows the literal authored placeholder
  "`${…}` that is a whole segment of `path` or a whole value in `query`, keyed by the expression " +
  // biome-ignore lint/suspicious/noTemplateCurlyInString: shows the literal authored placeholder
  'WITHOUT the `${}` (for example `"input.site_id"`, `"item.slug"`, `"scope.window.data.start"`); ' +
  "use `{}` when neither varies. Each entry is `{enum: [every allowed value]}` — for `input.*` " +
  "copy the value from the saved schedule input (`list_schedules`), for `item.*` list every value " +
  'the `for_each` source can yield. Only when the values CANNOT be listed use `{class: "…"}`: ' +
  "`uuid` or `integer` or `identifier` for an id that comes from an earlier step, `date` " +
  "(YYYY-MM-DD) or `timestamp` (UTC, ending in Z) for a time window. A class approves every value " +
  "of that form, so never use one where a list is possible, and never on a DELETE. Placeholders " +
  "in the body need no entry. `max_body_bytes` is the largest UTF-8 body this step may send (0 for GET/HEAD): size " +
  "it from the workflow's own limits (for example its batch cap times the bytes per item, plus " +
  "the fixed fields), never from a guess — a preview whose request does not fit fails with " +
  "`request_outside_declared_boundary` and names both numbers; " +
  "`max_calls` is the most requests per run (1 without `for_each`). A DELETE also needs " +
  "`destructive: true`. Not coverable yet: a placeholder in `headers`, a placeholder that is " +
  "only PART of a path segment or of a query value, a query KEY that varies, and `pagination`.";

/**
 * A step that ALREADY carries `boundary` (or can never carry one) and still
 * compiled none. Each entry names the one thing to change, or says plainly that
 * nothing the author can do covers it yet — never "add a boundary" again.
 */
const REQUEST_REFUSAL_REMEDY: Partial<Record<RequestBoundaryRefusal, string>> = {
  variables_mismatch:
    "This step already has `boundary`, but `boundary.variables` does not match the path: it needs " +
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shows the literal authored placeholder
    "exactly one entry per `${…}` in `path`, keyed by the expression without the `${}`, and no " +
    "entry for anything that is not in the path. Body placeholders get no entry.",
  boundary_invalid:
    "This step already has `boundary`, but it does not parse: `variables` maps an expression such " +
    'as `"input.site"` to `{enum: [...]}` (1 to 50 values of letters, digits, `.`, `_`, `~`, `-` ' +
    'only) or to `{class: "identifier" | "uuid" | "integer" | "date" | "timestamp"}`, never both; ' +
    "`max_body_bytes` is an integer from 0 to 10000000; `max_calls` an integer from 1 to " +
    "10000; `destructive` may only be `true`. No other keys.",
  delete_requires_destructive:
    "This step already has `boundary`; a DELETE additionally needs `destructive: true` inside it, so " +
    "a removal is never approved by omission.",
  delete_requires_enum:
    "This step already has `boundary`, but a DELETE may only vary over listed values: replace " +
    "each `{class: …}` with `{enum: [every value that may be removed]}`. A removal of anything " +
    "that merely looks like an id is not something a human can approve.",
  partial_segment_placeholder:
    "`boundary` cannot cover this step yet: a placeholder is only PART of a path segment, or its " +
    "root is not `input`, `scope` or `item`. Only a placeholder that is a whole segment between " +
    "two `/` can be bounded today. Do not add `boundary`; say so to the user.",
  query_placeholder_unsupported:
    "`boundary` cannot cover this step as written: a `query` value mixes text with a placeholder, " +
    "is not a plain string, or names a root other than `input`, `scope` or `item`. Only a query " +
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shows the literal authored placeholder
    'value that is one whole placeholder (`"${scope.window.data.start}"`) can be bounded, with an ' +
    "entry of its own in `boundary.variables`. Build the full value in a transform first if text " +
    "has to surround it.",
  runtime_header:
    "`boundary` cannot cover this step: a header value is a runtime placeholder. Make the header " +
    "a literal, or leave this step to concrete-run review.",
  runtime_value_outside_path_and_body:
    "This step has a runtime placeholder outside `path` and `body`. Only the path (whole segments) " +
    "and the body may vary under a boundary; make every other field a literal.",
  path_unsupported:
    "`boundary` needs exactly one of `path` or `url`, without `?`, `#`, `%` or `\\`. Move query " +
    "parameters into the step's `query` object.",
  pagination_unsupported:
    "`boundary` cannot cover a paginated step: a cursor can carry response data into the next " +
    "request. Do not add `boundary`.",
  variable_in_base_prefix:
    "This step already has `boundary`, but a path placeholder sits where the connector's base path " +
    "is matched. Start the path with the literal segments and put the placeholder after them.",
  enum_value_unroutable:
    "This step already has `boundary`, but one of its `enum` values does not route to the " +
    "reviewed target. Use the exact identifier the API expects, with no `/` or encoding.",
  target_unresolved:
    "The request target cannot be resolved: the connector has no base URL and the path is not an " +
    "absolute http(s) URL, or the target carries credentials or a fragment.",
  connector_adds_query:
    "`boundary` cannot cover this step: its connector appends query parameters of its own " +
    "(query-mode authentication or a static query), so no reviewed query could ever match.",
  stricter_profile_applies:
    "Do not add `boundary` here: this step is a report e-mail or a content publication, which has " +
    "its own stricter review of the recipient or the published items.",
  not_http_step:
    "`boundary` applies to plain HTTP request steps only. A storage step is bounded with " +
    "`s3.scope`; SQL, MCP, GraphQL, XML and multipart steps cannot be bounded yet.",
};

const GMAIL_REPORT_REMEDY =
  "A reviewed report boundary is not available yet; this alone does NOT establish malformed MIME. " +
  "First inspect the exact-version preview: did this email step materialize, or was it skipped " +
  "because an upstream request was held or failed? Repair the evidenced upstream cause before " +
  "changing email construction. sk.buildMimeMessage is supported for single-part text/html or " +
  "text/plain reports; Base64 content-transfer encoding is supported. Do not infer recipients from " +
  "transform source code: review checks the materialized message. Changing report content IS " +
  "supported. Keep method POST and endpoint fixed. Set body to an object with only raw, whose " +
  "VALUE may be a dynamic reference to the encoded message. Inspect the encoding transform: " +
  "decoded MIME MUST have explicit From and To mailbox addresses, Subject, MIME-Version: 1.0, " +
  "Content-Type: text/html or text/plain; preserve agreed addresses. Do not replace report content " +
  "with a constant. Save the repaired draft, open the real review card to prepare its held " +
  "preview, and recheck eligibility. No message is sent by that preparation.";

const REMEDIES: Partial<Record<ManifestIssueCode, Partial<Record<Driver, string>>>> = {
  dynamic_request: {
    s3: STORAGE_SCOPE_REMEDY,
    http: REQUEST_BOUNDARY_REMEDY,
  },
  destructive_effect: {
    s3: STORAGE_SCOPE_REMEDY,
  },
};

/**
 * Remedies for issues on steps that have no driver. A `call` step never becomes
 * an effect, so a remedy keyed by driver could not be reached for it: the issue
 * arrived bare, which is how a reader ends up proposing a one-off run instead.
 */
const DRIVERLESS_REMEDIES: Partial<Record<ManifestIssueCode, string>> = {
  unbound_workflow_call:
    "A step that calls another workflow cannot be bound for repeated runs yet: the child's " +
    "effects are not part of this workflow's reviewed boundary, so there is nothing for a human " +
    "to approve. If the call passes no `input` and no later step reads its result, remove the " +
    "call and give the child workflow its own schedule and its own approval. Otherwise the " +
    "requests the child makes have to be authored in this workflow so they can be reviewed " +
    "here. `boundary` and `s3.scope` do nothing on a call step. Say this plainly to the user; do " +
    "not offer a one-off run as a substitute for recurring approval.",
};

/**
 * The concrete remedy for one issue, or null when none is known.
 *
 * `target` lets a driver carry more than one profile: an http `dynamic_request`
 * means something different on the report-send endpoint than it does anywhere
 * else, and only the endpoint distinguishes them.
 */
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

/**
 * Guidance for every issue that has a known remedy, in issue order.
 *
 * A step with `missing_binding` never reaches `effects` at all (the compiler
 * skips it), so the driver is looked up leniently and an unknown one simply
 * yields no entry rather than a wrong one.
 */
export function repairGuidanceForIssues(
  issues: ReadonlyArray<{ step_id: string; code: ManifestIssueCode }>,
  effects: ReadonlyArray<{ step_id: string; driver: Driver; target: string | null }>,
  storageRefusals: ReadonlyArray<{ step_id: string; reason: StorageBoundaryRefusal }> = [],
  requestRefusals: ReadonlyArray<{ step_id: string; reason: RequestBoundaryRefusal }> = [],
): Array<{ step_id: string; code: ManifestIssueCode; instruction: string }> {
  const byStep = new Map(effects.map((effect) => [effect.step_id, effect]));
  const refusalByStep = new Map(storageRefusals.map((entry) => [entry.step_id, entry.reason]));
  const requestRefusalByStep = new Map(
    requestRefusals.map((entry) => [entry.step_id, entry.reason]),
  );
  const seen = new Set<string>();
  const guidance: Array<{ step_id: string; code: ManifestIssueCode; instruction: string }> = [];
  for (const issue of issues) {
    const effect = byStep.get(issue.step_id);
    // The specific refusal wins over the generic storage remedy. `no_scope`
    // has no entry on purpose: that IS the generic case.
    const refusal = refusalByStep.get(issue.step_id);
    // `no_boundary` has no entry on purpose: that IS the generic http case.
    const requestRefusal = requestRefusalByStep.get(issue.step_id);
    const instruction =
      (effect?.driver === "s3" && refusal ? STORAGE_REFUSAL_REMEDY[refusal] : undefined) ??
      (effect?.driver === "http" && requestRefusal
        ? REQUEST_REFUSAL_REMEDY[requestRefusal]
        : undefined) ??
      remedyFor(issue.code, effect?.driver, effect?.target);
    if (!instruction) continue;
    // The compiler can report the same code twice for one step (two failing
    // predicates); the reader needs the remedy once.
    const key = `${issue.step_id}:${issue.code}`;
    if (seen.has(key)) continue;
    seen.add(key);
    guidance.push({ step_id: issue.step_id, code: issue.code, instruction });
  }
  return guidance;
}
