---
slug: workflow-authoring
scope: global
title: Authoring Workflows In A Conversation
description: The canonical recipe for turning a user intent into a committed workflow draft: caller contract, grounding, author_workflow vs edit_workflow_patch, build vs run, failure caps and the repair signal.
activates_when: [{"kind":"tool","tool":"author_workflow"},{"kind":"tool","tool":"edit_workflow_patch"},{"kind":"tool","tool":"approve_discovery_artifact"},{"kind":"tool","tool":"preview_attachment"},{"kind":"tool","tool":"inspect_workflow"},{"kind":"tool","tool":"list_schedules"},{"kind":"tool","tool":"review_workflow_automation"},{"kind":"tool","tool":"run_workflow"},{"kind":"tool","tool":"dry_run_workflow"},{"kind":"tool","tool":"save_workflow_draft"},{"kind":"intent_keyword","word":"create workflow"},{"kind":"intent_keyword","word":"build workflow"},{"kind":"intent_keyword","word":"new workflow"},{"kind":"intent_keyword","word":"workflow erstellen"},{"kind":"intent_keyword","word":"workflow bauen"},{"kind":"intent_keyword","word":"workflow anlegen"},{"kind":"intent_keyword","word":"neuen workflow"},{"kind":"intent_keyword","word":"automatisch"},{"kind":"intent_keyword","word":"automatic"},{"kind":"intent_keyword","word":"recurring"}]
side_effects: read
idempotency: none
maturity: stable
tags: [authoring, workflow]
version: 45
---

# Authoring Workflows In A Conversation

This skill describes the happy path for building a workflow when the user is
talking to you in a conversation. The process is design-once / emit-once:
ONE `author_workflow` call produces the complete evaluated draft; the
micro-tools exist only to repair specific findings afterwards.

## Authenticated caller contract

Before authoring, identify four independent contracts: execution identity (`$caller`), saved connector credentials, RBAC/resource authorization, and human approval of effects. An approver is not automatically the caller. Authenticated HTTP/MCP invocations derive caller from their principal; trusted callerless webhook/schedule invocations use null, and children retain their parent's caller. Do not substitute a trigger creator, approval actor, input owner or request-source label. See subkit-concepts for examples and REST API knowledge for the observable run/audit evidence; persisted caller context is not a field exposed by execution inspection.

`$caller` is immutable execution identity supplied by SubKit authentication. It is available to every authenticated workflow, including generic workflows. It is `null` for trusted system invocations without a principal, such as callerless scheduler or webhook runs. A system account is an authenticated principal with `principalKind: "system_account"`; it is not the same as a callerless system run.

The runtime type is:

```typescript
type CallerContext = {
  tenantId: string;
  principalId: string;
  principalKind: "user" | "system_account";
  provider: string;
  productId: string | null;
} | null;
```

`tenantId` is a UUID. `principalId` is normally a UUID; generic `portal_token` user identities may instead contain the authenticated opaque end-user reference. `provider` is a nonempty, open string identifying the authentication provider, not a role or a closed enum. Use `principalKind` to distinguish users and system accounts. `productId` is a nonempty authenticated product identity or `null`; an ordinary authenticated workflow does not invent one. The object contains no credentials, tokens, email, roles or grants.

Use the syntax for the actual expression surface:

| Surface | Trusted identity reference |
|---|---|
| JavaScript transform function body | `input.scope.$caller` |
| JSONata, including `branch.when`, `data_selector`, `output_transform` | `$caller` |
| Request string placeholder | `${caller.principalId}` |

All five fields support `${caller.<field>}` placeholders. Never use `${$caller.principalId}`, `${input.owner_id}` or a hard-coded owner to authorize access. In JavaScript, `input.input` is the user payload; `input.scope.$caller` is the trusted identity. In JSONata, `$input` is the user payload and `$caller` is the identity. Caller-shaped input and step outputs cannot replace `$caller`. Step IDs `$caller` and `$input` are reserved. Queue, resume, loops and child workflows preserve the admitted caller, not a new identity from job input or child input.

## Sensitive execution

`execution_privacy: "sensitive"` is an explicit opt-in. It keeps detailed execution input and intermediate results out of the SubKit authoring LLM, encrypts persisted payloads, and requires the original authenticated caller for resume/result access. The authoring chat cannot run it live. `dry_run_workflow` runs a sensitive draft encrypted with every write held and returns metadata only: step statuses and kinds, held steps, safe failure codes, item counts with complete/truncated, validation and output_schema verdicts, and the type (array length) of each declared output field. You never see values; do not guess, describe or reconstruct them, and fix failures from step kinds, statuses and failure codes. When that test run is refused or must not read data, `dry_run_workflow` with `mode: "schema_only"` checks structure only: it validates the definition and compiles its expressions without running any step, dispatching any request or returning any value, and reports structure checked, content not checked. The metadata test run stays the default; `schema_only` is explicit and refused for drafts that are not sensitive. `dry_run_step` is refused for a sensitive draft. A direct MCP call may run an active saved version under the caller's normal permissions and execution authority; its bounded final output is returned to that caller. Sensitive execution refuses persistent state, event waits/signals, persistent pagination and prepared fixture replay; a bounded read-only GraphQL cursor collection can run inside one step without persisting pages. An ordinary parent cannot call a sensitive child. Generic opaque portal callers cannot resume sensitive executions. Prepare the definition without inventing private sample data. Fresh inspection, successful schema validation and a green metadata test run or passed `schema_only` check permit saving an immutable inactive sensitive draft through the normal human save policy; a failed check blocks the save and cannot be forced. Saving grants no execution authority, activates no version or trigger, and records runtime verification as `metadata_only` or `schema_only`. Report the result and that live verification happens in the Cockpit by the signed-in person, not in authoring chat. Use the documented execution/result APIs with the actual original caller for permitted execution and verification; do not embed a deployment's database, files, queues or private runtime in a workflow. Caller support needs no product-specific engine fork.

## The canonical flow

**Proof-before-proposal contract.** Before calling `author_workflow` or
`edit_workflow_patch`, you MUST have a successful
`probe_connector` (or `call_connector`) result for EVERY connector the
workflow will use. A probe verifies that the credential resolves and the
base URL responds; a `call_connector` call on a primary endpoint records
the real response shape. Skipping this step is the largest single source
of authoring-time errors — the pipeline generates against guesses, and
the session-level failure rate for un-probed connectors is 364 dry-run
retries in the worst recorded session.

1. **Ground** — `get_engine_status`, then `list_connectors` to see what's
   already wired. For EVERY connector the workflow will call:
   (a) `probe_connector` to verify credentials and base URL respond — a
   successful probe records the real response shape as shape evidence;
   (b) `call_connector` on the primary endpoint(s) when the probe alone
   does not cover the response shape you need (e.g. pagination, a
   collection endpoint, a nested resource); and
   (c) `search_docs` / `search_knowledge` when the endpoint surface is
   unclear. Only proceed to step 2 once EVERY connector has a green probe.
2. **`author_workflow`** (ONE call) — pass the user's goal VERBATIM plus the
   connector ids/slugs (and an `input_example` when the user supplied one).
   Pass an explicitly requested workflow `name` and `slug` in those tool fields.
   Inspect the resulting draft and correct requested identity BEFORE preview:
   a green preview may save immediately. Never postpone naming to a persisted
   `update_workflow` call, which creates an unnecessary separate decision.
   The engine grounds generation in the recorded endpoint samples + docs,
   generates the COMPLETE definition (steps, transforms, input/output
   schema, trigger), evaluates it against recorded evidence with bounded
   auto-repair, and stashes it as the draft. Read the returned
   `recorded_eval` — findings carry verified `repair.expression` proposals.
3. **`dry_run_workflow`** — previews the draft. Dry-runs HOLD WRITES: read
   steps execute live; write steps (sends, posts, publishes) are fully
   resolved — URL, headers, the materialized body — but NOT dispatched;
   the held request is recorded as the step artifact. After a green
   preview the instruction-grounded judge evaluates the artifacts (held
   payloads included) against the stashed goal. In `auto`, green + judge
   pass may commit inline. In `ask`/`plan`, the preview returns
   `save_required: true` and the normal save gate decides.
4. **Repair on findings** — apply specific recorded-eval/judge findings via
   `edit_workflow_patch` (an RFC 6902 JSON Patch: append/replace a step,
   set a single field or header, add an edge, reorder), then preview again.
   `dry_run_transform` iterates a transform against the recorded scope
   without re-hitting the network.
5. **Persist according to permission mode** — after a clean judged preview,
   read the envelope. `auto_committed: true` means an inert draft save already landed.
   `save_required: true` means call `save_workflow_draft` and surface its
   structured human approval.

`edit_workflow_patch` is THE editor: use `author_workflow` for the initial
whole-draft build, then `edit_workflow_patch` for every targeted change.
"Change the limit to 5" on a previewed or committed workflow is a
one-patch edit.

Persistence and activation are separate. Do not call a preview-only or
saved-but-inactive draft live. `auto_committed: true` or a successful
`save_workflow_draft` establishes only the exact stored draft version.
Neither operation changes the active workflow, its schedules or webhooks,
and neither grants execution authority. Read `persistence_kind`,
`activation_required` and `current_version_id` from the result. Use
`dry_run_workflow` for further previews; do not run an older active version
as a substitute for the newly saved draft. Review the exact version and
effects before activation. A capability Skill-Candidate describing the
draft is also only preparation, not a transitive activation approval.

**Dry-runs hold writes — sends never fire in a preview.** Write steps
(email sends, webhook posts, publishes) are resolved against real upstream
data and recorded as held request artifacts; nothing leaves the engine.
The judge reads the held payload — the would-be email is judged BEFORE any
send. A full-live preview (writes actually dispatched) exists only behind
the explicit confirmation machinery, for the rare case that genuinely
needs the write's response shape recorded. Externally-visible destinations
(recipient address, channel, webhook URL) must still come from the user —
never fabricate placeholders like `test@example.com`; the value ends up in
the committed workflow.

## Build vs run — do not confuse them

When the user says **build / create / make / author** a workflow — especially when
they paste example data or paths for a workflow that does not exist yet —
that is **authoring** intent: call `author_workflow`. It is NOT a
`run_workflow` request. `run_workflow` ONLY executes a workflow that is
already saved. If `run_workflow` returns `workflow_not_persisted`, do
**not** retry it — switch to `author_workflow`. Repeating `run_workflow`
after that error trips the loop-detector and wastes the entire turn.

**Never use `run_workflow` / `wf_<slug>` to TEST a workflow while
authoring — that is what `dry_run_workflow` is for.** Both run tools now
HOLD write-classified steps by default: a send/post/publish is fully
resolved but NOT dispatched, the held step shows `writes_held: true` and
the held step ids in the envelope, and the audit row records
`execute_writes: false`. So a verification run cannot fire a real email —
but it also is not the verification path. Verify a draft with
`dry_run_workflow` (it holds writes AND runs the instruction judge); use
`run_workflow` only to actually RUN a saved workflow for the user. A real
live send happens only when the user explicitly asks to run for real and
you pass `execute_writes: true` — that path requires a confirmation even
in dev (a real send must be human-approved). `inspect_workflow_draft`
labels every step `side_effect: "read" | "write"`, so you can see which
steps would dispatch before you ever run.

**A green preview auto-commits only in permission mode `auto` and only when
the quality gate permits it.** In `ask`/`plan`, even a judged passing preview
returns `save_required: true` and
`next_best_actions: ["save_workflow_draft"]`. A backgrounded MCP surface can
surface the durable approval URL through `conversation_get`, so it does not
weaken this gate. Persist deliberately with `save_workflow_draft` rather than
re-running the preview.

## `author_workflow` vs `edit_workflow_patch`

| Situation | Tool |
|---|---|
| New workflow, not yet saved in this conversation | `author_workflow` (one call, engine generates + evaluates) |
| A workflow this conversation is already bound to (it has a saved or active version) | `edit_workflow_patch` — always, however many operations it takes |
| Apply one specific finding (path fix, repaired expression, limit change) | `edit_workflow_patch` (`replace /steps/N/...`) |
| Append or replace one step during repair | `edit_workflow_patch` (`add /steps/-`, `replace /steps/N`) |
| Retarget or add an edge between steps | `edit_workflow_patch` (`add /edges/-`, `move`) |

Rule of thumb: **default to `author_workflow`** for the FIRST build, and never for a workflow that is already saved — twenty patches are cheaper than one dropped guard. The
engine's grounding (recorded endpoint samples, docs, the JS contract) is
strictly better than hand-assembling steps, and the result arrives already
evaluated. Then use `edit_workflow_patch` for every targeted edit — it is
THE editor, an RFC 6902 JSON Patch over the whole draft.

## Authoring recipe (mandatory order before `author_workflow` / `edit_workflow_patch`)

Skipping any of these steps produces a draft authored against a guessed
shape that fails at runtime. Follow the order:

1. **Load skills.** `load_skill` for `data-handling` plus the relevant
   protocol skill(s) (`http-connectors`, `postgres-connectors`,
   `s3-connectors`, `graphql-connectors`) and any domain skill the tenant
   has seeded.
2. **`list_connectors`.** Note `id`, `slug`, `base_url`, stored credentials.
3. **`probe_connector` (MANDATORY — do not skip).** Verify credential
   resolves and base URL responds. A green probe records the response
   shape as evidence that grounds generation. Call this for EVERY
   connector the workflow will use. Skipping the probe is the primary
   cause of authoring-time failures — the pipeline generates against
   guesses instead of real shapes.
4. **`call_connector` (probe supplement).** Call the primary endpoint(s)
   and capture the real response shape when the probe alone does not
   cover the endpoint you need (collection endpoints, nested resources,
   paginated lists). Prefer `call_connector` over guessing response shape
   from documentation.
5. **`search_docs` and `search_knowledge`.** Look up endpoints, auth,
   pagination, response structure. Do not guess paths from the URL.
   For a POST search/report API, use one request step with
   `pagination.parameter_location: "body"`, the vendor's offset/limit names,
   `items_path`, and a bounded `max_pages`; do not unroll guessed page counts
   into duplicate steps.
6. **Only then** call `author_workflow` to build the draft (and
   `edit_workflow_patch` for any targeted edit afterwards). The pipeline
   grounds generation in the recorded shapes; without them it generates
   against guesses.

When in doubt, load more skills rather than fewer.

## Five consecutive failures → ask the user

Never make more than **five failed tool calls in a row** without asking
the user. A "failed tool call" is any `tool_result` with `ok: false`,
or `dry_run_workflow` / `run_workflow` whose `status` is `failed` or
whose `requires_repair` is `true`. The counter resets on the first
successful tool call.

When the cap is reached, emit `ask_user_choice` with three concrete
business options derived from the failure (e.g. use an available account,
keep the previous version, or stop preparation), with the effect and a
grounded recommendation. Never offer a technical bypass or hand-editing
JSON as routine user work. Do not continue patching.

## Repair signal: read `requires_repair`, not the warning count

`run_workflow` and `dry_run_workflow` return a top-level
`requires_repair: boolean` separately from `warnings`. The flag drives
the repair loop; warnings alone do not. `transform_dropped_fields` is
informational when a projection intentionally narrows fields.

| `status` | `requires_repair` | What you do |
|---|---|---|
| `succeeded` | `false` | Show the output. The run is correct. |
| `succeeded` | `true` | Read warnings, repair, re-validate. |
| `partial_success` | `false` | Show the output — it is the answer. |
| `partial_success` | `true` | Same as `succeeded + requires_repair: true`. |
| `failed` | (any) | Read `error.code`, repair the offending step. |

When the user has a working result on screen, never propose a "fix" or
a "simpler version" because of warnings alone.

## Inspect before patching

When a step's output looks wrong, do NOT guess at paths. Call
`inspect_workflow` to read the captured shape of every step from the
most recent run, then author the next patch against the returned shape.
Use this BEFORE the third `edit_workflow_patch` on the same field —
`inspect_workflow` returns the path that actually exists, not the one
you assumed. Shape: `{ sections: [...], steps: [{ stepId, include }] }`.

## User dialogue

Technical diagnosis belongs in tool calls, not in the conversation narrative. Do not stream your debugging hypotheses, patch paths, payload shapes, encoding details or internal error names to the user. A suitable progress sentence is “Ich prüfe, was den regelmäßigen Versand blockiert.” Give the verified business result and one actionable review card afterwards. Ask only about an unresolved business choice; never ask the user to choose an encoding, repair a patch or validate a technical diagnosis.

- User-facing questions and labels describe outcomes (for example “Bericht veröffentlichen”), never parameters such as `publish=true`, raw cron expressions or tool names.

Own the preparation: inspect, check, repair and save within the actual permission mode. Never ask the user to invoke a tool or interpret code. “Do not run live” still allows the permitted hold-writes preview; an explicit prohibition of previews does not. Preserve existing schedules and destinations unless the user requests a change. Resolve genuinely missing business input through `ask_user_choice`, `ask_user_text` or `ask_user_form`: one short question, clear effects, and a grounded recommendation. Use the canonical confirmation tool for required authority. Report the verified result in 1–3 sentences; no field tables, code or tool names unless requested.

Absence of a report-delivery boundary is missing evidence, NOT proof of malformed email. First check whether the exact-version held preview reached the email step. If an upstream request was held or failed, diagnose that upstream result; rewriting MIME cannot fix missing input. When the email step was held, its `report_delivery_inspection` names the rule the message broke (`not_utf8`, `header_control_byte`, `extra_recipients`, …); start there. The built-in `sk.buildMimeMessage` produces what the review accepts: one sender and one recipient, each `addr` or `Name <addr>`, a Unicode subject, and a UTF-8 text/plain or text/html body, or both as `multipart/alternative`. Do not replace it merely because it is a helper. Hand-built MIME must be encoded with `sk.base64UrlEncodeUtf8`, never `sk.base64UrlEncode`, which keeps one byte per character. Cc, Bcc, Reply-To, custom headers and attachments stay outside the review. Sender and recipient are checked on the materialized message, not inferred from transform source code. Inspect the actual step shape before applying a patch; never guess a `config` wrapper. A successful run with held prerequisites does not verify skipped downstream steps.

## Model steps

To classify, summarize, extract or draft text, use a `model` step: `prompt`, optional `system` and `input` (data, never instructions), required `output_schema`. Its answer is the step's `data`; it counts against the spend limit and `max_llm_tokens_per_run`. Never call a model provider with a raw request step; such calls are capped and accounted too.

## Focused authoring skills

Topic rules live in the `workflow-authoring-*` skills of the skill index. Their tools, step kinds, diagnosis codes or phrases mark them loaded and unlock their tools, but their rules reach you only through `load_skill`. Call `load_skill('workflow-authoring-<topic>')` before acting on its topic: `structures` for loops, `for_each`, branches and parallel steps, `transforms` for transform code, `repair` for patches and diagnoses, `automation` and `schedules` for triggers and activation, `boundaries` for effect and request limits, `product-callers` for product identity, storage scope and Supabase, `transactional-mail`, `output-format` and `loop-examples`.
