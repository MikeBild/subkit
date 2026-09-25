---
slug: workflow-authoring
scope: global
title: Authoring Workflows In A Conversation
description: The canonical recipe for turning a user intent into a committed sk workflow draft.
activates_when: [{"kind":"tool","tool":"author_workflow"},{"kind":"tool","tool":"edit_workflow_patch"},{"kind":"tool","tool":"approve_discovery_artifact"},{"kind":"tool","tool":"preview_attachment"},{"kind":"tool","tool":"inspect_workflow"},{"kind":"tool","tool":"list_schedules"},{"kind":"tool","tool":"review_workflow_automation"},{"kind":"tool","tool":"run_workflow"},{"kind":"intent_keyword","word":"freigabe"},{"kind":"intent_keyword","word":"automatisch"},{"kind":"intent_keyword","word":"automatic"},{"kind":"intent_keyword","word":"recurring"}]
side_effects: read
idempotency: none
maturity: stable
tags: [authoring, workflow]
version: 39
---

# Authoring Workflows In A Conversation

This skill describes the happy path for building a workflow when the user is
talking to you in a conversation. The process is design-once / emit-once:
ONE `author_workflow` call produces the complete evaluated draft; the
micro-tools exist only to repair specific findings afterwards.

## Chat completion and human review

In cockpit, a saved draft is reviewed inside the current chat with “Review saved change”. This opens the exact-version effect and limit dialog; the human can apply the change and allow bounded automatic runs in one decision. Never send API commands, ask the user to activate externally, or use call_connector to call the engine. Use review_workflow_automation to render the actual bounded review card in chat. Never use ask_user_confirm for recurring-run permission: it cannot create execution authority. A held-write preview does not send an email and is not a live test. Report these outcomes separately. A repaired credential alone does not authorize a changed workflow. If run_workflow reports activation required, stop retrying and point to the chat review action. If access preparation fails, inspect the precise connector/environment once and repair the evidenced problem; do not invent cache or checkpoint causes. Never claim the next scheduled run will happen without observed authorized automation status.

## Automatic operation completion

- Inspect `list_schedules` for the workflow after preparation and before claiming that automatic operation is ready. Read `automation.state`, not just `paused`.
- `repair_required`: a successful preview is insufficient; resolve the reported unsupported effect boundary. If this cannot be supported without changing the business result, ask one short business question with a recommendation. Do not repeat an unchanged preview or the same preparation handoff indefinitely.
- `approval_required`: explain that preparation is finished and automatic runs still need the user's bounded permission. Point to the automatic-run review available directly in the chat. A choice to keep the schedule unchanged is not this permission.
- `activation_required`, `paused`, `input_required`, or `verification_unavailable`: name the missing step briefly; never promise the next automatic run.
- Only `authorized` is evidence of current permission; it is rechecked at dispatch. Do not claim that an actual run succeeded until its execution record confirms that.
- User-facing questions and labels describe outcomes (for example “Bericht veröffentlichen”), never parameters such as `publish=true`, raw cron expressions or tool names.

## Preview existing scheduled work with its real settings

When repairing a scheduled workflow, omit `input` from `dry_run_workflow` to reuse the single enabled schedule in the selected environment. Do not send an empty object or fabricate IDs, sites, repositories or dates: reads contact real systems. If schedules are ambiguous, inspect them and ask only the missing business choice. A preview failure caused by absent or invented input is not evidence that the workflow works; repair the input and rerun. Never propose a forced save to conceal that failure. Use `inspect_workflow_draft` with `step_ids` for targeted current configuration rather than repeatedly loading full old execution results.

## Target existing steps by ID

For a field change inside an existing top-level step, prefer `edit_workflow_patch` with `step_patches: [{step_id, op, path, value}]`. The path is relative to that step, e.g. `/s3/scope` or `/expression`. The engine resolves the stable ID against the current draft, so you must not count numeric positions from a long workflow or use a `config` wrapper. Use ordinary `patches` only for workflow-level structure changes. Never mix the two forms. Both use the same validation and inert-draft persistence gates.

## Repair preparation before handoff

When a user asks to prepare missing recurring permission, inspect the saved definition and current readiness first. A repeated successful held-write preview does not repair missing boundaries. If a supported boundary is missing, prepare the actual inert draft change and verify it; do not merely describe the problem or call it ready. Preserve the full existing storage key prefix (including namespace segments such as `v1/`), schedule, destinations and business inputs. Use a readiness card only after actual preparation or to explain a specific remaining unsupported capability. Do not say the user's approval is the only missing action while `automation.state` is `repair_required`. After `save_workflow_draft`, read `automation_readiness` in its result: when `eligible_for_repeated_runs` is false, follow its `repair_guidance` step by step, preview and save again in the SAME turn. Do not call `review_workflow_automation` before it reports eligible — that tool ends the turn with the card, and a human cannot repair a refused boundary from a card. A green preview proves the requests fit their boundaries; only `automation_readiness` says whether every boundary was accepted.

## Bounded report storage

When a workflow's automation review reports `dynamic_request` or `destructive_effect` on a step that uses the s3 driver, the supported remedy is exactly one thing: author `s3.scope` on that step. Nothing else removes those two codes for a storage step. For a step on the http driver see "Bounded requests" below; `s3.scope` does nothing there. `max_keys` and `paginate` are derived by the engine from the step itself — they can never be set or templated per prefix. For recurring S3 report reads and writes, inspect the current draft and its actual keys before patching. A request may propose `s3.scope: { key_prefix, max_bytes }`, plus `max_deletes` when the step removes objects: a fixed, narrow folder ending in `/`, a maximum UTF-8 write size (at most 10000000 bytes), and for a removal a maximum number of objects (at most 10000). GET, HEAD, LIST and PUT are supported; DELETE is supported only with `max_deletes`, and that ceiling is a reviewed number rather than a per-run count the engine enforces — say so plainly instead of implying the total is capped. Keep existing business folders and choose a justified file-size limit; never broaden to an entire bucket to make review pass. This binds hardest on a removal step: if one folder would have to cover every key it touches, split it into narrower per-folder removal steps rather than widening the prefix. LIST also uses fixed `max_keys` and `paginate` limits. File names and PUT contents may vary only inside the reviewed boundary. Metadata, range reads, presigned links and multipart uploads are not supported by this recurring profile.

This scope is a proposal, never permission. Prepare and preview the change, then use `review_workflow_automation` for the human's exact-version review in chat. Explain which report folder may be read or written and that saving can replace existing files there. Do not ask the user to edit JSON, choose patch indices, or understand storage protocol options. Read the actual draft structure before each patch. If other effects remain unsupported, diagnose those instead of claiming the whole workflow is ready.

## Bounded requests

When the automation review reports `dynamic_request` on a step that uses the http driver, and the step is not a report e-mail or a content publication (those keep their own, stricter review), the supported remedy is `boundary` on that step. It states which targets the step may reach and how large its body may be, so a human can approve the step once for repeated runs. Patch only that step: `edit_workflow_patch` with `step_patches: [{step_id, op: "add", path: "/boundary", value: {variables, max_body_bytes, max_calls}}]`. `boundary` sits directly on the step beside `method` — not under `s3`, `config` or `body`. Do not change `path`, `body` or `for_each` to make it fit.

`variables` has exactly one entry per `${…}` placeholder that is a whole segment of `path` or a whole value in `query`, keyed by the expression without the `${}` — `"input.site"`, `"item.slug"`, `"scope.window.data.start"`. Use `{}` when neither varies. Placeholders in the body get no entry; the body is limited by size only. An entry is normally `{enum: [every value it may take]}`: 1 to 50 values written exactly as they are sent — letters, digits, `.`, `_`, `~`, `-`, `:` and `%XX` escapes (`123:runReport`, `https%3A%2F%2Fexample.com%2F`). For `input.*` copy the value from the saved schedule input (`list_schedules`). For `item.*` list every value the `for_each` source can yield. Never invent a value and never list more than the workflow needs: every value is a target the human approves. Only when the values cannot be listed — an id produced by an earlier step, a date or time window — use a value class instead: `{class: "uuid"}`, `"integer"`, `"identifier"`, `"date"` (YYYY-MM-DD), `"timestamp"` (UTC text ending in `Z`) `"file_name"` (one file name, exactly one dot: `my-essay.md`; never a path, so a step that addresses `folder/name.md` needs the folder as its own literal segment) or `"path"` (the whole rest of the address: `de/datenstand/`, `robots.txt`, `/`). Use `"path"` only when the step really does vary the entire path — a step that fetches whatever route an earlier step listed — and only on the LAST placeholder in `path`; anywhere else it is refused with `path_class_misplaced`, because it would swallow the literal segments after it. It approves every page on that one address, so prefer any narrower rule that fits. A window the API takes as unix seconds is `"integer"`, not `"timestamp"` — read the real value from the same step in the last real run before choosing a class. When a preview refuses a value it names the parameter, the value and the rule; change that one rule. A class approves EVERY value of that form, and the review dialog says so; prefer a list whenever one exists, and never use a class on a DELETE. `max_body_bytes` is the largest UTF-8 body the step may send (0 for a GET or HEAD, at most 10000000). Derive it from the workflow's own limits — for a list of identifiers, the batch cap times the bytes per identifier plus the fixed fields — and never from one preview or a round guess: a step is held to the boundary it declares on every run, preview included, and a request that does not fit fails with `request_outside_declared_boundary` naming the actual and the allowed size. Correct the number then; do not remove the boundary and do not shrink the workflow's output to fit a guessed limit. `max_calls` is the most requests per run (1 without `for_each`, at most 10000); it is a reviewed number the engine does not count yet — say so plainly rather than implying a hard cap. A DELETE additionally needs `destructive: true`, so a removal is never approved by omission.

A value may contain `:` and percent escapes, but percent-encoding is never a way around the one-segment rule: `%2F` is a literal character to the server, not a separator, so `a%2Fb` addresses something that does not exist and the request fails. One placeholder per segment, always. A placeholder that is only PART of a path segment (an identifier followed by `:action`, a prefix such as `team:` before an id) or several segments inside one placeholder cannot be bounded as written. Re-author minimally: let a transform, or the step that builds the `for_each` items, produce each WHOLE segment as its own value, reference each as its own placeholder, and list the full values; change nothing else. Not coverable at all yet, so do not add `boundary` and tell the user instead: a placeholder in `headers`, a query KEY that varies, `pagination`, and a connector that adds its own query parameters. When a step already has `boundary` and the review still reports it, the review names the reason; change that one thing. Do not add the boundary again and do not widen the `enum`.

A `call` step is now part of what an approval covers: the workflow it starts is reviewed with this one, its requests appear in the dialog under that step, and the approval pins the child's exact version — activating a new child version asks the human again. Three things are still refused, and `review_workflow_automation` names which: the child is archived or deleted (`child_unavailable`); the step does not name exactly ONE fixed workflow, by `workflow_id` or by `workflow_slug` and not both, with no placeholder in it (`target_not_static`); the child itself starts a workflow (`child_calls_workflow`), because approving that would approve a chain whose far end nobody reviewed. `boundary` and `s3.scope` do nothing on a call step — the child's own steps carry them, and they have to be authored in the CHILD workflow, in its own chat. After changing and activating a child, review the parent again. An issue that belongs to the child says so; do not try to repair it here.

A boundary limits where a request goes and how large it is — not what it says. When the body decides which records are changed or removed, tell the user that in one sentence before the review card; the review dialog says the same.

## User dialogue

Technical diagnosis belongs in tool calls, not in the conversation narrative. Do not stream your debugging hypotheses, patch paths, payload shapes, encoding details or internal error names to the user. A suitable progress sentence is “Ich prüfe, was den regelmäßigen Versand blockiert.” Give the verified business result and one actionable review card afterwards. Ask only about an unresolved business choice; never ask the user to choose an encoding, repair a patch or validate a technical diagnosis.

Preparation is not a request to perform the workflow now. For an already-saved workflow, use `run_workflow` with `execute_writes: false`, even when a `wf_<slug>` tool is available. That runs the ACTIVE version. When this chat holds a saved change that still awaits review, preview that change with `dry_run_workflow` instead — `run_workflow` refuses while a saved change is pending, and a refusal is not a reason to show the review card unchecked. When `dry_run_workflow` reports `unverified_boundaries`, those steps were skipped in the preview: compare each one's folder, size or target with the same step in the last real run (`inspect_execution_step`) or with the transform that builds it, and correct it before the review card. The synthetic tool is for an explicitly requested live run and can open a one-shot confirmation; do not use that confirmation as a substitute for recurring automation review.

When checking an existing scheduled workflow, use its saved schedule inputs. `run_workflow` with `execute_writes: false` and omitted input inherits the single enabled schedule in the chosen environment; passing `{}` explicitly does not. Do not diagnose empty loop iterations as a workflow defect until you have checked the actual input. Never ask the user to reconstruct technical input already stored in the schedule. A fixed URL may still be blocked by a dynamic body or unsupported operation: read the manifest and actual request before claiming the URL is the cause. Unsupported engine capabilities cannot be repaired by pretending a one-off run is recurring permission. Explain that limitation briefly; do not offer “ignore the scheduler” as a repair.

Absence of a report-delivery boundary is missing evidence, NOT proof of malformed email. First check whether the exact-version held preview reached the email step. If an upstream request was held or failed, diagnose that upstream result; rewriting MIME cannot fix missing input. The built-in `sk.buildMimeMessage` supports single-part UTF-8 plain-text/HTML report messages with Base64 transfer encoding. Do not replace it merely because it is a helper. Sender and recipient are checked on the materialized message, not inferred from transform source code. Inspect the actual step shape before applying a patch; never guess a `config` wrapper. A successful run with held prerequisites does not verify skipped downstream steps.

Own the preparation: inspect, check, repair and save within the actual permission mode. Never ask the user to invoke a tool or interpret code. “Do not run live” still allows the permitted hold-writes preview; an explicit prohibition of previews does not. Preserve existing schedules and destinations unless the user requests a change. Resolve genuinely missing business input through `ask_user_choice`, `ask_user_text` or `ask_user_form`: one short question, clear effects, and a grounded recommendation. Use the canonical confirmation tool for required authority. Report the verified result in 1–3 sentences; no field tables, code or tool names unless requested.

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

For request steps, use the current flattened shape: `connector_id`, `method`,
`path`, `query`, `headers`, `body`, and `graphql` live directly on the step.
Do not wrap them in `config`.

## Typed JSON bodies and read-only POSTs

Two general request-body rules worth getting right up front (the
`http-connectors` skill has the full treatment):

- **A whole-value placeholder leaf carries its native type.** A body field
  that is exactly `"${ref}"` — nothing around it — reaches the wire as the
  referenced value's real JSON type: a number stays a number, an array stays
  an array, an object stays an object. Wrap the placeholder in surrounding
  text (a mixed string like `"id-${ref}"`) and the value is stringified
  instead. This is what lets a dynamically-built array ship as a real JSON
  array — compute it in a transform, then reference it whole:

  ```json
  { "body": { "children": "${scope.build_blocks.data}" } }
  ```

  `build_blocks` returns an array, so the API receives
  `{"children": [ … ]}`, not a quoted string.

- **Mark read-only POSTs with `side_effects: "read"`.** Some search / query
  endpoints use `POST` but mutate nothing. The runtime classifies steps as
  write by HTTP method, so dry-run HOLDS them by default. Set
  `side_effects: "read"` on such a step so dry-run runs it live and the judge
  sees real data. Use it ONLY for endpoints that genuinely read; a `POST`
  that creates / updates / sends stays a write. `side_effects` is an existing
  step field — no new schema.

## Design rule: prefer one bulk list endpoint over a nested per-item loop

When the vendor offers a list endpoint that returns the collection with
the fields the goal needs, fetch it ONCE and reshape with a single
transform. Reach for a loop over a per-item detail endpoint only when the
list payload genuinely lacks a required field. One bulk call + one
transform beats N detail calls on every axis: fewer steps, fewer failure
modes, no rate-limit pressure, and the recorded sample covers the whole
shape.

## Transforms — JavaScript first

Every new `transform` step defaults to `language: "javascript"`. The
execution contract (verified against the QuickJS runtime — this is exactly
how the engine runs it):

- The authored code is a **FUNCTION BODY** (not a module, not an arrow
  function). The engine wraps it as `(function (input) { <body> })` and
  invokes it once; the body must `return` its result (a trailing
  expression also works).
- Exactly ONE value is exposed: the `input` argument.
  - `input.scope.<step_id>.data` — the recorded output of each upstream
    step (every step output is uniformly enveloped; read through `.data`).
  - `input.input` — the workflow input.
- The sandbox is QuickJS WASM with zero host globals — no `fetch`, no
  `process`, no `require`, no network, no `Date.now`/`Math.random`
  nondeterminism. Values are JSON-marshalled in and out.

```json
{
  "id": "shape_projects",
  "kind": "transform",
  "language": "javascript",
  "expression": "const projects = input.scope.fetch_projects.data.projects; return projects.map(p => ({ id: p.id, name: p.name }));"
}
```

A curated `sk` stdlib global is pre-installed in the sandbox (see
"sk-Stdlib" below). `output_transform_function` is the JS form of the
workflow-level output transform (mutually exclusive with the JSONata
`output_transform`).

### JSONata is NOT a transform language

A `transform` step is JavaScript-ONLY. JSONata is not a valid transform
language — `language: "jsonata"` on a `transform` step is rejected by the
schema. JSONata survives only in `data_selector`, `loop.over`,
`branch.when`, `output_transform`, and `${scope.x.data}` string
interpolation. When you write JSONata in one of THOSE slots, the
addressing contract is strict:

- Upstream steps: `$scope.<step_id>.data…` (bare `<step_id>.data` also
  resolves). Workflow input: `$input`.
- Inside a loop body the current item is **`$item` ONLY** (plus
  `$loop_index`). `item_var` is retired: declaring it is rejected, and a
  bare item name (`project.name`) is rejected at authoring time with a
  `did_you_mean: "$item.name"` rewrite.

## `for_each` — inline per-step iteration (preferred over `loop` for simple fan-out)

Any step (request, transform, call, wait) can declare a `for_each` field
on `baseStep`. It replaces the standalone `loop` step for simple flat
iteration: no body array, no sibling step ids, no container/child
exclusion — just ONE step that runs once per element.

```json
{
  "id": "fetch_resource",
  "kind": "request",
  "method": "GET",
  "connector_id": "<connector_id>",
  "path": "/v2/projects/${item.id}/resources",
  "for_each": "(sourceData) => sourceData.fetch_projects.data.projects"
}
```

**`for_each` contract:**

- The value is a **JS arrow function** (or any expression) that receives
  `sourceData` (the full execution scope, i.e. `input.scope`) and returns
  an array. The expression is evaluated by the QuickJS runtime.
- Each iteration binds `$item` (the current element) and `$loop_index`
  (zero-based) into the substitution scope — identical to a `loop` body.
- Inside the step's `path`/`url`/`headers`/`query`/`body` strings: use
  `${item.<field>}` (same as loop body placeholders).
- Inside JSONata `data_selector` on the SAME step: use `$item.<field>`.
- The step output is an array of envelopes (one per iteration), keyed by
  iteration index: `$scope.<step_id>.data[i]`.

**`for_each` vs `loop` kind — when to use which:**

| Situation | Use |
|---|---|
| Simple fan-out: one step per item, no sibling body steps needed | `for_each` on the step (preferred) |
| Each iteration needs multiple sequential sibling steps | `loop` with `body: [...]` |
| HATEOAS expansion needing two sequential passes | Two flat `for_each` steps separated by a transform |

**Parallelism — `for_each` fans out, `loop` does not.**

When iterations are independent, `for_each` is also the FAST choice, not
just the simple one:

- A `for_each` over a **read** request (GET / GraphQL query / SQL SELECT /
  S3 GET·HEAD·LIST) runs its iterations **concurrently** with a bounded
  pool (default 8). N independent reads cost ~1 roundtrip of wall-clock,
  not N. This is automatic — you do not declare anything.
- **Writes** (POST/PUT/PATCH/DELETE, mutations) stay **sequential** by
  default — firing writes in parallel without intent is unsafe. Opt in
  deliberately with `for_each_concurrency: <N>` on the step ONLY when the
  writes are truly independent.
- The standalone **`loop` step always runs strictly sequentially** — there
  is no concurrency knob on it. So a `loop` whose body is N independent
  reads pays N× the wall-clock for no reason. If the body is a single
  independent read, rewrite it as a `for_each` step to get the parallel
  fan-out for free; reserve `loop` for bodies that genuinely need multiple
  ordered sibling steps per item.
- Tune an explicit bound with `for_each_concurrency` (integer ≥ 1; `1`
  forces sequential). Lower it when the upstream API rate-limits hard.

**Addressing `for_each` output downstream (after the step):**

- JS transform: `input.scope.<step_id>.data.map(iter => iter.<field>)`
- JSONata: `$scope.<step_id>.data[*].<field>`

A step with `for_each` is NOT a container — it is a regular step that
the runtime expands inline. The static container/child exclusion that
applies to `loop.body` steps does not apply here.

## Nested / tree data — traverse it, don't silently flatten

Some APIs return a TREE, not a flat list: Notion page blocks
(`/blocks/{id}/children`, where any block with `has_children: true` has
its own children one fetch deeper), a file/folder hierarchy, an org →
teams → members chain, threaded comments. The engine **cannot nest
loops**, so you cannot recurse to unbounded depth in one workflow. Two
failure modes to avoid:

- **Silent truncation.** Fetching only the top level (`/children` once)
  and rendering that drops every nested node. The run reads green while
  toggles, list items, nested callouts, sub-pages, and replies are
  silently lost. If the user asked for "the whole page" / "all
  descendants", a one-level fetch does NOT satisfy the goal.
- **Catch-all transforms that return empty.** A renderer that handles a
  fixed set of node types and returns `""`/`null`/`[]` for everything
  else discards unmatched content with no signal. Handle the unmatched
  case explicitly (pass through, or record what was skipped). The
  `transform_empty_extraction` warning now fires when a transform yields
  empty output over non-empty input — treat it as a real bug, not noise.

**The bounded-depth pattern (no nested loops):**

1. Fetch level 0 (paginated: `page_size=100` + `start_cursor`).
2. `for_each` over the nodes where `has_children` (or the API's
   equivalent flag) is true → fetch their children. This is one flat
   `for_each`, and because the fetch is a read it fans out in parallel.
3. Repeat per expected depth, OR — preferably — ask the user how deep
   the data actually goes and stop there. State the depth bound in the
   workflow so it is explicit, not accidental.

If the data is arbitrarily deep, say so to the user and agree on a depth
limit rather than pretending one workflow flattens an unbounded tree. A
connector with a **GraphQL** endpoint often collapses the whole traversal
into ONE nested query — prefer it over N+1 REST descents when available
(see the GraphQL connector skills).

## Recurring cadence is part of the workflow definition

If the user's goal phrases a cadence — examples below — the workflow
**MUST** carry a `trigger: { kind: "schedule", cron, tz, execution_mode }` field. The
execution mode defaults to `prod`; use `dev` explicitly only for an authoring loop. The
schedule binding is part of the workflow definition, not a separate
call. `author_workflow` generates the trigger from the goal phrasing (and
`edit_workflow_patch` can set or change it later); on commit `applyTriggerBindings`
upserts the `workflows_schedules` row and emits the
`schedule.trigger.bound` audit event. **Do not call `create_schedule`
separately for a brand-new workflow** — that path is for binding a cron
to an already-saved workflow, and creating a parallel binding without the
workflow's own `trigger` field leaves the two out of sync.

Cadence phrasings that require a `schedule` trigger:

- English: "every day at 7pm", "daily at 9am", "hourly", "every weekday
  at 09:00", "every Monday morning", "every 10 minutes", "weekly on
  Friday", "at 18:00 UTC".
- German: "täglich um 18 Uhr", "stündlich", "jeden Werktag um 9", "jeden
  Montagmorgen", "alle 10 Minuten", "wöchentlich freitags".

Cron-translation contract (the LLM owns this; **do not** ask the engine
for a regex-to-cron translator — none exists):

| Phrase | Cron |
|---|---|
| "every day at 7pm" | `0 19 * * *` |
| "daily at 9am" | `0 9 * * *` |
| "weekdays at 09:00" | `0 9 * * 1-5` |
| "every Monday morning" | `0 8 * * 1` |
| "every 10 minutes" | `*/10 * * * *` |
| "hourly" | `0 * * * *` |
| "weekly on Friday" | `0 9 * * 5` |

Timezone resolution chain — apply in order, stop at the first match:

1. If the user prompt names an IANA timezone (`Europe/Berlin`,
   `America/New_York`, `Asia/Tokyo`) or a colloquial city ("Berlin",
   "New York"), use it verbatim — translate colloquial names to IANA.
2. Otherwise, fall back to the tenant default exposed in the
   conversation context (when present).
3. Otherwise, default to `UTC`.

Negative examples — these phrases are NOT cadence and must not produce
`trigger.kind=schedule`:

- "send a webhook every time stripe charges fail" → `trigger.kind = "webhook"`.
- "retry the failed step every 30 seconds" → step-level retry config, not a workflow trigger.
- "the workflow runs in production" → operational note, not cadence.

## Schedule questions must be grounded by `list_schedules`

When the user asks about existing schedules ("list my scheduled
workflows", "is my daily report still scheduled", "which jobs run at
night"), call `list_schedules` **this turn** before answering. Do not
infer schedule state from prior turns or session memory — the table can
change between turns. The same rule applies to `get_schedule` /
`list_workflows` when the question is workflow-specific.

If the user asks to "reschedule" or "change the time of" a workflow,
the path is:

1. `list_schedules` (or `list_workflows`) to locate the row.
2. `update_schedule` (or re-author the workflow with a new
   `trigger.cron`) to apply the new cadence.

Never claim a tool is unavailable without naming the structured
envelope it returned. The palette in this conversation is fixed and
listed in the tool schemas — if a tool you need is genuinely absent,
call `cannot_help` with `reason: "tool_missing"` and the tool name.

## Repair-in-chat: failed run → diagnose → recommit

A persisted workflow that fails does NOT need a new draft. Stay in
chat; the same tools repair in place:

1. **Read the failure** — the `run_workflow` result has `error.code`,
   `error.message`, failing `step_id`, captured response shape. Do not
   paraphrase the error away.
2. **`diagnose_latest_execution`** — pulls causal trace; do not guess from the bare error.
3. **Edit the offending step** — `edit_workflow_patch` covers every targeted change: set a single field or header (`replace /steps/N/...`), replace a step body, add or retarget an edge (`add /edges/-`). For schema drift on a request step, `probe_connector` first; if the connector's response shape changed over time, call `propose_schema_migration` (returns a structured rename/add/remove/widen plan against the recorded shape ledger) before deciding how to patch the transform. A saved workflow is changed with `edit_workflow_patch`, however many operations that takes: `author_workflow` regenerates the whole definition and keeps only what the goal restates, so guards and safety checks in the saved version disappear silently. It refuses a workflow this conversation is bound to, and there is no override: patches can replace every step, so any redesign is expressible. If a patch keeps failing, fix what its error names instead of switching tools.
4. **`validate_draft`** — re-runs structural checks (rarely needed; see below).
5. **`dry_run_workflow`** — preview the patch. In `auto`, a green judged run may commit inline. In `ask`/`plan`, call `save_workflow_draft` after `save_required: true`; the structured human gate decides. Any structural change must run dry-run first.

Do not instruct the user to run `sk workflow commit` (no CLI fallback exists). Do not re-run the failed workflow before re-validating (overwrites the diagnosis). Do not skip failing steps with `if: false` unless the user asks for that behaviour. After three failed repair iterations on the same error, stop and ask the user.

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

## Metadata-only edits — `update_workflow`, never the build/preview cycle

Changing an EXISTING workflow's **description, display name, or
lifecycle/archive** (and nothing about its steps) is a metadata edit. Call
`update_workflow` directly with the workflow `id` and only the field(s) that
change. It writes the `workflows.description` column (the source of the
`wf_<slug>` tool description), does NOT roll a new version, and needs NO
draft, dry_run, or `save_workflow_draft`. **Do not run or preview the
workflow to change its description** — editing text is never a reason to
execute. Resolve the `id` first via `find_workflow` / `get_workflow`.

If the edit is gated by a confirmation, attach
`commit_intent: { kind: "update_workflow_metadata", payload: { id, description } }`
to `ask_user_confirm` so the approval persists the change directly (no second
tool call). `update_workflow` is metadata-only: if the draft also has STEP
edits it refuses with `uncommitted_step_edits` — commit those via
`save_workflow_draft` first. Step / schema / trigger changes always go through
the draft + `save_workflow_draft`, never `update_workflow`.

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

## Reshape locations

Three places to reshape data — pick the smallest one that fits:

- **Step-level `data_selector`** — trim a step's `.data` for downstream consumers (drop heavy fields).
- **`transform` step** — reshape across multiple upstream steps, or compute derived values. JavaScript by default (see "Transforms — JavaScript first").
- **`output_transform_function`** (JS, preferred for new workflows) or **`output_transform`** (JSONata, legacy) — workflow-level final payload the caller sees (hide internals). Pick exactly one — the schema rejects setting both. Same affordance pattern as `validation_expression` (JSONata) vs `validation_function` (JS).

See `data-handling.md` for full examples.

## Workflow-level execution guards

These controls live at the workflow root, beside `steps`; they are not step
parameters and must not be hidden in `description`:

- **`max_llm_tokens_per_run`** — positive integer cap for cumulative prompt
  plus completion tokens across all LLM-provider calls in one run. Use it for
  every model-backed workflow whose safe cost ceiling is known.
- **`timeout_ms`** — positive integer wall-clock timeout for the workflow run.
- **`validation_function`** / **`validation_expression`** — fail-closed final
  output invariants. Pick the JavaScript or JSONata form, not both.
- **`runtime`** — versioned runtime metadata such as `stdlib_version`; preserve
  existing values when editing a saved workflow.

`inspect_workflow`, `edit_workflow_patch`, draft validation, and
`save_workflow_draft` preserve these fields. If the operator asks to set one,
patch the actual top-level field and verify it in the inspected draft; a prose
mention does not enforce anything at runtime.

## Output format fidelity — emit the format the goal names, as a string

When the goal names a concrete output FORMAT — "a markdown table", "CSV",
"a bulleted list", "an HTML email body", "a slack message" — the final
payload (`output_transform_function`, or the last transform that feeds it)
MUST RENDER that format as a STRING. The correct data returned as a JSON
array/object does NOT satisfy "return a markdown table": the caller asked for
the table, not the rows behind it. This is a real miss — a single-shot build
can compute a correct ranking yet hand back structured data, and a reader
expecting markdown gets none.

Render the format explicitly in JS. A markdown table from an array of rows:

```json
{
  "id": "render_table",
  "kind": "transform",
  "language": "javascript",
  "expression": "const rows = input.scope.rank_cities.data; const head = '| rank | city | warmest_day | max_temp_c |\\n| ---: | --- | --- | ---: |'; const body = rows.map((r, i) => `| ${i + 1} | ${r.city} | ${r.warmest_day} | ${r.max_temp_c} |`).join('\\n'); return head + '\\n' + body;"
}
```

The rule generalizes: CSV → a header line + `\n`-joined comma rows; a bulleted
list → `lines.map(l => '- ' + l).join('\\n')`; HTML → the actual tag string.
The deterministic shape (a header, a separator row for markdown tables, one
row per record) is what a downstream reader — and the preview judge — checks
for. When the goal is format-specific, treat the rendered string as the
output contract, not an afterthought.

## `input_schema` vs `input_schema_sample`

- **`input_schema`** — JSON Schema, enforced at runtime. Use for stable contracts (another workflow, a known webhook).
- **`input_schema_sample`** — literal example payload, used by dry-run + LLM context. Not enforced.

Both can coexist:

```json
{
  "input_schema": {
    "type": "object",
    "required": ["tenant_id"],
    "properties": { "tenant_id": { "type": "string", "format": "uuid" } }
  },
  "input_schema_sample": {
    "tenant_id": "6a3c8f2e-1d5b-4b7a-9c4e-8f2b1d5a3c7e",
    "options": { "dry_run": true }
  }
}
```

## Multi-step structures

### Loops

Iterate over an array from a prior step. Each iteration exposes the
current item as `$item` (JSONata) / `${item.…}` (request strings),
plus `$loop_index` (zero-based). The item is NOT envelope-wrapped.
`item_var` is retired and rejected.

**Evidence-gated loop authoring.** A loop step that reads `$scope.<X>`
(or the equivalent bare form `<X>.data`) needs recorded preview
evidence for X. The evidence is **fingerprint-keyed**: it survives
edits to OTHER steps and goes stale only when X's own definition
changed since the last dry-run (gate reason
`preview_stale_for_referenced_step`). Enforcement differs by tool:

- BOTH authoring tools — `author_workflow` and `edit_workflow_patch` —
  ACCEPT the mutation and return a `recorded_eval` findings block in the
  same result: per-expression compile/eval status (caret-pointed JSONata
  errors; sandboxed JS evaluation), scope-reference evidence states
  (recorded / stale / missing), the loop/transform gate verdicts,
  `missing_evidence`, and ordered `next_actions`. Read it — acceptance
  is not proof the expressions resolve. Probed connectors count as
  shape evidence.
- `edit_workflow_patch` never REFUSES a loop `over` / `data_selector`
  edit with missing/stale evidence: it accepts the edit and surfaces
  the `loop_authoring_requires_inspect` verdict as a NON-BLOCKING
  `recorded_eval` finding, so the model repairs on the next call instead
  of thrashing on an identical retry. The fix is unchanged — dry-run once
  to record the shape, then re-apply.

Recovery is one round-trip, never a rebuild: call `dry_run_workflow`
once so the engine records `scope_at_step` for the changed step, then
retry the SAME edit — unchanged steps keep their evidence, so one
dry-run per genuinely-new shape suffices. Then call
`suggest_jsonata_paths` (returns ranked path candidates against the
recorded preview, with fallback to the last committed version's
`scope_index` and the most recent execution when no fresh draft
preview exists) or `inspect_workflow_draft` (returns each step's
preview side-by-side with config). Authoring a loop's `over` against
the LLM's mental model of the API instead of the recorded preview is
how 4–9× retry spirals start.

**Same rule for `transform` steps.** A transform whose expression
cites a sibling X (`$scope.<X>` in JSONata, `input.scope.<X>` in JS)
with missing or stale evidence is surfaced the same way: both authoring
tools accept the edit and report it in
`recorded_eval` as a NON-BLOCKING `transform_authoring_requires_inspect`
finding (no tool hard-refuses it any more). Same fix: `dry_run_workflow`
once, then author the transform against the recorded `output_preview`
(visible via `inspect_workflow_draft`). Hard-coding placeholder
strings (`"item 1"`, `"unknown"`) as defaults to dodge the gate is
forbidden — that's how the "succeeded with garbage output" transcript
happened (`get-last-3-gmail-messages with human output`).

**Iterating on a transform — prefer `dry_run_transform`.** Once a green
`dry_run_workflow` has recorded the upstream step's `output_preview`,
further edits that only touch a transform's `expression` should call
`dry_run_transform` — *not* `dry_run_workflow`. `dry_run_transform`
evaluates the expression (JSONata or JS) against the recorded sample
without re-hitting the network, so a transform debug loop costs O(1) ms
per iteration instead of O(s) and avoids burning vendor rate-limit on
the same upstream call twelve times in a row. Pass the previewed scope
path (e.g. `$scope.fetch_issues`) as `sample_data`; the tool resolves it
from the latest cached dry-run. Only fall back to `dry_run_workflow`
when you actually change a request/connector/loop step, or after several
green transform iterations to confirm end-to-end.

**Validation is auto-surfaced; you rarely need `validate_draft`.**
Every authoring turn's context block already includes a
`- Validation: N errors` section with the field paths. Calling
`validate_draft({})` to re-check what you just read is loop-detected
(the tool is no longer exempt from the per-tool repeat cap). Reserve
it for forcing a re-check after a change applied OUTSIDE the
conversation (operator hand-edit, external import).

**Bare-path step refs are validated.** Forms like `fetch_users.data`
(no `$scope.` prefix) are equivalent to `$scope.fetch_users.data`
and are validated identically. A typo in the leading identifier is
rejected at authoring time with `workflow_unresolved_step_reference`.

**`output_transform` / `output_transform_function` references are
validated too.** Same rule: every `$scope.<id>...` and bare
`<id>....` reference in the workflow-level transform must point at a
real step.

**`authoring_scope_changed` warning fires when consecutive dry-runs
lose paths.** If a step previously published `data.results[*].email`
and the next dry-run no longer surfaces that path (e.g. an upstream
API silently dropped a field), the warning lists every removed path
so downstream transforms / loops can be re-checked before re-
committing. The check is skipped when the workflow draft was
structurally rewritten between dry-runs (mutation_seq guard).

**Catalog discovery.** Use `find_workflow` / `find_connector` /
`find_skill` (free-text keyword search across the saved catalogs)
before reaching for `list_workflows` / `list_connectors`. They are
faster for tenants with more than ~50 workflows or connectors and
return ranked matches in one call.

**`author_workflow` and `edit_workflow_patch` return `persistence: "draft_only"`.**
Neither auto-saves — the fields make this explicit so the LLM never
assumes a workflow is committed before the green, judged preview.

**Scope vocabulary survives commits.** After every successful run
the engine writes `step_id → scope_at_step` to
`workflow_versions.scope_index`. Repair-author sessions opening
months later have `suggest_jsonata_paths` populated from this
persisted vocabulary even before the first dry-run.

**`loop.over`** is JSONata evaluated with the same bindings as the
other JSONata slots (`data_selector`, `branch.when`): `$input`,
`$scope`, `$steps`, and
unpacked `$<key>` bindings. Both forms below are equivalent — pick
whichever reads better:

- `over: "$scope.<step_id>.data"` (matches the skill's documented
  envelope path; symmetric with transform expressions)
- `over: "<step_id>.data"` (bare path against the root scope object)

**`branch.when`** is the same surface — `$scope.<step_id>.data.field`
or bare `<step_id>.data.field` both resolve.

**HTTP / placeholder substitution** (path, url, headers, query, body): use
`${item.<path>}`. This is the only form the runtime placeholder resolver
accepts — `${user.field}` or `${project.id}` will fail with
`placeholder_unresolved` because `user` / `project` are not registered
placeholder kinds.

**NEVER write Mustache `{{ ... }}` anywhere.** It is not a placeholder
syntax; the engine ships the literal string upstream and the URL gets
percent-encoded (you get `%7B%7B%20$item.id%20%7D%7D` in the request and
the API answers 404). `{{ $item.id }}`, `{{ $loop.item.id }}`,
`{{ project.id }}` are all wrong — the only correct form for the loop
item inside a string field is `${item.id}`. The draft validator rejects
Mustache shapes with code `workflow_unsupported_placeholder` and a
concrete `did_you_mean` rewrite, so never propose a Mustache
placeholder.

### Loop shape

```json
{
  "id": "send_emails",
  "kind": "loop",
  "over": "$scope.segment.data.users",
  "body": ["send"]
}
```

Body step referencing the item via the placeholder resolver:

```json
{
  "id": "send",
  "kind": "request",
  "method": "POST",
  "path": "/mail",
  "body": { "to": "${item.email}", "name": "${item.name}" }
}
```

`$loop_index` (zero-based) is also available inside the loop body.

### Inside a loop body — addressing table

Loop-body scope addressing is the single most common source of
authoring churn. There are exactly two expression surfaces and each
accepts exactly one form — mixing them surfaces as
`placeholder_unresolved` or `unresolved_identifier`:

| You need | JSONata expressions (`data_selector`, `branch.when`) | Request placeholder strings (`path` / `url` / `headers` / `query` / `body`) |
|---|---|---|
| Current item field | `$item.name` (the ONLY form — bare item names are rejected) | `${item.name}` |
| Iteration index (zero-based) | `$loop_index` | not available — derive it in a prior transform if needed |
| Sibling body step's result (same iteration) | `$scope.<body_step_id>.data.<field>` | `${scope.<body_step_id>.data.<field>}` |
| Loop output downstream (AFTER the loop) | `$scope.<loop_id>.data.<body_step_id>.data.<field>` | prefer a transform step instead |

`$item` and `$loop_index` are ALWAYS bound inside the body — the runtime
builds the child scope as `{ ...scope, $item: item, $loop_index: i }` —
and each finished body step's envelope joins the same child scope so
later siblings in the SAME iteration can read it. `${project.id}` /
`${user.email}` are NEVER valid placeholders: the placeholder resolver
accepts only the kinds `cred | connector | input | scope | item | state`,
and the JSONata surface binds the item as `$item` only.

Compact worked example — a request + a transform inside one body:

```json
[
  {
    "id": "iterate_repos",
    "kind": "loop",
    "over": "$scope.list_repos.data.repositories",
    "body": ["fetch_languages", "shape_repo"]
  },
  {
    "id": "fetch_languages",
    "kind": "request",
    "method": "GET",
    "connector_id": "<github_connector_id>",
    "path": "/repos/${item.full_name}/languages"
  },
  {
    "id": "shape_repo",
    "kind": "transform",
    "language": "javascript",
    "expression": "return { name: input.scope.$item.name, index: input.scope.$loop_index, languages: input.scope.fetch_languages.data };"
  }
]
```

`fetch_languages` (request) addresses the item via `${item.full_name}`;
`shape_repo` (transform) reads the current item via `input.scope.$item`,
the always-bound `input.scope.$loop_index`, and its sibling's result via
`input.scope.fetch_languages.data`. After the loop, a downstream transform
reads `input.scope.iterate_repos.data.shape_repo.data.name`.

**`body` is an ARRAY of step ids.** Write
`body: ["fetch_languages", "shape_repo"]` — never a string
(`body: "fetch_languages"` fails validation with
`steps.N.body — expected array, received string`) and never inline
step objects. The body steps themselves live as siblings in the
top-level `steps` array.

### Authoring order — body steps before the loop

A `loop` step's `body: ["A", "B"]` references sibling steps A and B.
`author_workflow` emits the whole array at once so ordering is solved by
construction; when repairing with `edit_workflow_patch`, add the body steps
**first**, then the loop. The incremental draft validator accepts forward
references on `loop.body` / `branch.then_steps` / `parallel.branches[]`
(returned as `pending_forward_refs`), but `dry_run_workflow` and
`save_workflow_draft` still reject the draft until every referenced id
exists.

### Loop output shape

`$scope.<loop_id>.data` is an array of iteration objects, each keyed
by body step id with a full ScopeEnvelope inside. Path to a body field:
`$scope.<loop_id>.data.<body_step_id>.data.<field>`.

To project across iterations, use a JS transform
(`input.scope.<loop_id>.data.map(iter => iter.<body_step_id>.data…)`).
Transforms are JavaScript — there is no JSONata transform form. If
fewer keys come out than went in, a `transform_dropped_fields` warning fires
(informational only — see "Repair signal" below).

Debugging — call `inspect_workflow` (multi-step) or
`inspect_execution_step` (single step from a prior run) to read the real
shape before authoring the next projection. Do not guess at paths.

### Worked example: list DigitalOcean projects + their resources

This is the canonical pattern when a user asks for "list every X with its
resources / children / details" AND no bulk endpoint covers it. (Check
for a bulk list endpoint first — see the design rule above.)

```json
[
  {
    "id": "fetch_projects",
    "kind": "request",
    "method": "GET",
    "connector_id": "<digitalocean_connector_id>",
    "path": "/v2/projects"
  },
  {
    "id": "extract_projects",
    "kind": "transform",
    "language": "javascript",
    "expression": "return input.scope.fetch_projects.data.projects.map(p => ({ id: p.id, name: p.name }));"
  },
  {
    "id": "fetch_resources",
    "kind": "loop",
    "over": "$scope.extract_projects.data",
    "body": ["get_project_resources"]
  },
  {
    "id": "get_project_resources",
    "kind": "request",
    "method": "GET",
    "connector_id": "<digitalocean_connector_id>",
    "path": "/v2/projects/${item.id}/resources"
  },
  {
    "id": "format_output",
    "kind": "transform",
    "language": "javascript",
    "expression": "return input.scope.fetch_resources.data.map(iter => ({ project: iter.get_project_resources.data ? iter.get_project_resources.data.project_name : null, resources: iter.get_project_resources.data.resources }));"
  }
]
```

Four rules this example encodes:
1. Loop body uses `${item.id}` in HTTP placeholders (NOT `${project.id}`). The placeholder resolver only accepts `cred|connector|input|scope|item`; `${project.id}` becomes `placeholder_unresolved`.
2. **EVERY step output is uniformly enveloped** as `{data, status_code?, headers?, duration_ms, error}` — including `transform` and `loop`. The loop's `over` reads `$scope.extract_projects.data` (the array), not `$scope.extract_projects` (the envelope). See `data-handling.md`.
3. Loop output is at `$scope.<loop_id>.data.<body_step_id>.data` (envelope-in-envelope) — in JS: `input.scope.<loop_id>.data[i].<body_step_id>.data`.
4. `${item.…}` for path/url/headers/query/body strings; `$item` for JSONata expressions. Mixing surfaces as `placeholder_unresolved` or `unresolved_identifier`.

### Worked example: HATEOAS link expansion (follow `links.self`)

When a list endpoint returns resources with a `links.self` URL pointing
at the full record (DigitalOcean, GitHub, Stripe, JSON:API services),
the natural author shape is **two flat loops** — one to fetch the IDs,
a second one to flatten and re-fetch each `links.self`. Do NOT try to
nest loops; the body of a `loop` step is an array of step ids, not
another loop.

```json
[
  {
    "id": "fetch_projects",
    "kind": "request",
    "method": "GET",
    "connector_id": "<digitalocean_connector_id>",
    "path": "/v2/projects"
  },
  {
    "id": "fetch_resources",
    "kind": "loop",
    "over": "$scope.fetch_projects.data.projects",
    "body": ["get_project_resources"]
  },
  {
    "id": "get_project_resources",
    "kind": "request",
    "method": "GET",
    "connector_id": "<digitalocean_connector_id>",
    "path": "/v2/projects/${item.id}/resources"
  },
  {
    "id": "flatten_links",
    "kind": "transform",
    "language": "javascript",
    "expression": "const HOST = 'https://api.digitalocean.com'; const out = []; for (const iter of input.scope.fetch_resources.data) { for (const r of iter.get_project_resources.data.resources) { out.push({ urn: r.urn, path: r.links.self.slice(HOST.length) }); } } return out;"
  },
  {
    "id": "expand_resource",
    "kind": "loop",
    "over": "$scope.flatten_links.data",
    "body": ["fetch_resource_detail"]
  },
  {
    "id": "fetch_resource_detail",
    "kind": "request",
    "method": "GET",
    "connector_id": "<digitalocean_connector_id>",
    "path": "${item.path}"
  },
  {
    "id": "merge_full_details",
    "kind": "transform",
    "language": "javascript",
    "expression": "return input.scope.expand_resource.data.map(iter => ({ detail: iter.fetch_resource_detail.data }));"
  }
]
```

Three rules this encodes:
1. **Strip the connector base URL before reusing `links.self`.** The
   connector's `base_url` already includes the path prefix (e.g.
   `/v2`). If you write `${item.url}` against a connector with
   `base_url: https://api.digitalocean.com/v2`, the URL resolver pastes
   the full self URL on top and you double the host. Use `${item.path}`
   where `path` was extracted by stripping the host in the previous
   transform.
2. **Flatten before the second loop.** A loop body cannot recursively
   loop; the body field is an array of step ids. Project the parent
   loop output into a flat array of `{ ...parent_keys, path }` objects
   before the second loop runs.
3. **Use `${item.path}` not `${item.links.self}`.** The path is what
   the connector expects relative to its base_url. The full self URL
   (host included) is rejected with `404` because the host is fixed by
   the connector definition.

Alternative — **`expand_links` directive** (when the API consistently
uses `links.self` and you want to skip the manual flatten):

```json
{
  "id": "fetch_resources_expanded",
  "kind": "request",
  "method": "GET",
  "connector_id": "<digitalocean_connector_id>",
  "path": "/v2/projects/${item.id}/resources",
  "expand_links": ["links.self"]
}
```

The HTTP driver follows every `links.self` URL in the response (capped
at 50 per request) and embeds each fetched body under `_resolved` next
to the original entry. Use the manual two-loop pattern when you need
control (rate limits, conditional expansion); use `expand_links` when
the shape is consistent.

### JSONata flavour rules (variable blocks, dynamic keys, concatenation)

These apply to the JSONata slots (`loop.over`, `branch.when`,
`output_transform`, `data_selector`). Three syntax rules real sessions
repeatedly got wrong. Each produces a compile error
(`expression_invalid` with a caret position, also surfaced as a
`compile_error` finding in `recorded_eval`) — do not burn dry-runs
rediscovering them:

1. **`$x := …` variable binding lives in a parenthesized block.**
   `( $x := expr; result )` IS valid JSONata — at the top level of an
   expression or inside any parentheses (including a parenthesized
   object-constructor value). A bare `:=` directly inside an object
   constructor value is NOT.

   ```text
   WRONG: { "total": $t := $sum(items.price), "count": $count(items) }
   RIGHT: ( $t := $sum(items.price); { "total": $t, "count": $count(items) } )
   ```

2. **No dynamic object keys via a plain constructor over an array.**
   Mapping an array through an object constructor yields an ARRAY of
   single-key objects, not one merged object. To build a single object
   keyed by data, `$merge` the mapped singles (or fold with `$reduce`):

   ```text
   WRONG: $scope.repos.data.{ $string(id): name }   /* array of {k:v} singles */
   RIGHT: $merge($map($scope.repos.data, function($v) { { $string($v.id): $v.name } }))
   ```

   (In a JS transform this is just
   `return Object.fromEntries(input.scope.repos.data.map(r => [String(r.id), r.name]));` —
   another reason new transforms default to JS.)

3. **`&` is BINARY string concatenation — never unary.** There is no
   prefix `&`; both operands are required, and non-string operands must
   be cast with `$string()`.

   ```text
   WRONG: & name & " (" & id & ")"
   RIGHT: name & " (" & $string(id) & ")"
   ```

### Unresolved-identifier warnings are never false positives

If `dry_run_workflow` or `run_workflow` returns a warning of code
`unresolved_identifier`, the workflow is **broken**, not "warned". The
runtime parsed your JSONata and could not bind one of the names you
referenced. Common causes:

- You wrote `$scope.fetch_X` (no `.data`) — that is the envelope, not the
  payload. Add `.data`. **Every step has the same envelope shape, including
  transforms and loops.**
- You referenced the loop item by a bare name (`project.name`) — the
  runtime binds the current item as `$item` only.
- You typo'd a step id (`$scope.fetcch_projects`).
- You used `$$` to "fix" the JSONata when you actually wanted
  `$scope.<step_id>.data` or `$item`.

(JS transforms don't have this failure class — a wrong path throws a
real `TypeError` with the runtime's own message instead.)

The `save_workflow_draft` tool refuses to advance until the warning is
gone or the operator explicitly forces with `force_commit: true`. Do
not tell the user "this is a false positive" — the engine surfaces these
warnings precisely because they are not.

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

### Branches

First case whose `when` evaluates truthy runs. `default` runs if none match.

```json
{
  "id": "route",
  "kind": "branch",
  "config": {
    "cases": [
      { "when": "$scope.classify.data.tier = 'enterprise'", "steps": [ /* white-glove path */ ] },
      { "when": "$scope.classify.data.tier = 'pro'",        "steps": [ /* pro path */ ] }
    ],
    "default": [ /* self-serve path */ ]
  }
}
```

### Parallel

`join: "all"` waits for every branch. `join: "any"` resolves on the first. Each
branch has its own isolated scope but can read `$scope.<upstream_id>.data` from
steps that finished before the `parallel`.

```json
{
  "id": "fanout",
  "kind": "parallel",
  "config": {
    "branches": [
      [ { "id": "write_pg", "kind": "request", "config": { /* postgres INSERT */ } } ],
      [ { "id": "write_s3", "kind": "request", "config": { /* s3 put */ } } ]
    ],
    "join": "all"
  }
}
```

## sk-Stdlib in the sandbox

`transform` steps with `language: "javascript"` and before-request hooks
run inside QuickJS with a curated `sk` global pre-installed. Frozen
surface, deterministic (no `Date.now`, no `Math.random`, no host I/O).
Available calls:

- `sk.http.isMutating(method)` / `sk.http.isSafe(method)` — method classification
- `sk.http.METHODS.READ` / `WRITE` — pre-baked method arrays
- `sk.get(obj, "a.b.c", fallback)` / `sk.has(obj, path)` — null-safe access
- `sk.allow()` / `sk.deny(reason)` — canonical hook decisions
- `sk.pick(obj, keys)` / `sk.omit(obj, keys)` — subset / exclusion
- `sk.pluck(arr, key)` / `sk.groupBy(arr, keyOrFn)` / `sk.uniq(arr)` — array reshapers
- `sk.base64Encode(input)` / `sk.base64UrlEncode(input)` — JSONata-compatible
  low-8-bit base64 helpers; use when migrating `$base64encode` transforms and
  preserving byte-identical output matters
- `sk.base64EncodeUtf8(input)` / `sk.base64UrlEncodeUtf8(input)` — UTF-8
  base64 helpers; prefer for new Unicode text payloads such as MIME/API bodies
- `sk.base64Decode(input)` / `sk.base64DecodeUtf8(input)` — inverse decoders
  (binary-string and UTF-8); tolerate url-safe alphabet and missing padding
- `btoa(input)` / `atob(input)` — Web-standard binary-string base64 globals
  (`btoa` throws on code points > 255 — use `sk.base64EncodeUtf8` for Unicode)
- `sk.hexEncode(input)` / `sk.hexDecode(input)` — lowercase-hex codec
- `sk.buildMimeMessage({ from, to, subject, html?, text?, cc?, bcc? })` —
  complete RFC822 email + its base64url form (`raw` for Gmail send). ALWAYS
  use this for email bodies: headers are ASCII-only per RFC 5322, and a raw
  non-ASCII Subject ("–", umlauts) gets Latin-1-mangled by the mail server.
  Never hand-assemble the MIME string
- `sk.mimeEncodeHeaderValue(value)` — RFC 2047 encoded-word for one header
  value, when custom header assembly is unavoidable
- `sk.emailBody(message)` — decoded `{ text, html }` bodies of an email
  message envelope; the vendor wire format is detected by shape (Gmail
  `messages.get?format=full` payload tree with base64url parts, or a
  pre-decoded `{ body: { contentType, content } }` object). ALWAYS use this
  to read email content — `snippet` is a truncated teaser, not the message;
  shipping it as the body is the "succeeded with garbage output" failure
- `sk.rfc3339Parts(dateTime)` — faithful `{ date, time, offset, wall }` split
  of an RFC 3339 date/date-time WITHOUT timezone conversion (the sandbox has
  no tz database). For calendar events, format via `wall` and pass the
  vendor's `dateTime` + separate `timeZone` field through UNTOUCHED — slicing
  the string drops the offset and silently shifts times
- `sk.documentToMarkdown(value)` — rich document structures to markdown,
  preserving annotations (bold/italic/code) and links; the vendor format is
  detected by shape (Notion `blocks.children.list` response, block array, or
  rich_text span array). Unknown block types degrade to their text content,
  never to `""`. Use this instead of hand-rolled block renderers, which
  silently drop annotations
- `sk.sha256(input)` — SHA-256 of `input` (UTF-8), lowercase hex
- `sk.hmacSha256(key, msg)` — HMAC-SHA-256, lowercase hex (signed-request auth)
- `sk.now()` / `sk.nowIso()` — the execution's fixed timestamp (epoch ms / ISO);
  use these instead of `Date.now()` / `new Date()`, which are not available
- `sk.uuid()` — deterministic per-step UUID; use instead of `Math.random()` ids
- `sk.isString / isNumber / isArray / isObject / isNil` — type guards
- `sk.version` — stdlib version (persisted for drift detection)

Prefer the stdlib over raw comparisons so hook + transform code stays uniform.

**Never hand-roll base64, hex, or crypto.** Do not paste a base64/base32/hex
alphabet string or build a reverse-lookup table inside a transform — use
`sk.base64Encode` / `sk.base64Decode` / `sk.hexEncode` / `sk.hexDecode` /
`sk.sha256` / `sk.hmacSha256`. A hand-rolled encoder is rejected by the
authoring gate, and a redacted alphabet literal has corrupted authored code
into a malformed payload in production. Likewise never reach for `new Date()`,
`Date.now()`, or `Math.random()` — they are absent by design; use `sk.now()`,
`sk.nowIso()`, and `sk.uuid()`.

- The gate detects the literal alphabet form (a base64/base32/hex sequence
  pasted as a string), not chained string concatenations or
  `String.fromCharCode` tricks — don't try to evade it, just call the
  `sk.base64*` / `sk.hex*` helpers.

## Common pitfalls

- **Hand-assembling a new workflow step-by-step.** Initial authoring
  is ONE `author_workflow` call (the grounded pipeline builder); use
  `edit_workflow_patch` only for targeted edits afterwards.
- **Skipping `probe_connector` or `call_connector` before `author_workflow`.**
  The pipeline generates against guesses. A missed probe is the highest-
  leverage source of authoring failures — verified across 364 dry-run
  retries in one session. Probe every connector, call the primary
  endpoint, then author. No exceptions.
- **Using the `loop` kind for simple one-step fan-out.** Prefer `for_each`
  on the step (`for_each: "(sourceData) => sourceData.<step>.data.<array>"`).
  The `loop` kind is only needed when the iteration body requires multiple
  sequential sibling steps or nested aggregation.
- **Skipping `dry_run_workflow` and reaching for `save_workflow_draft`
  directly.** In `ask`/`plan`, `save_workflow_draft` uses the human gate and the inner
  prior-approval check may reject with `no_prior_approval`. In `auto`, ordinary
  inert saves do not require that decision. In every mode the persistence
  contract starts with a green judged preview. If the dry-run is failing, the
  workflow needs a fix, not a force-commit.
- **Calling `save_workflow_draft` after a green `dry_run_workflow`.** The
  correct next action is envelope-dependent: after `auto_committed: true`, a
  save only earns an `already_persisted` round-trip; after
  `save_required: true`, call `save_workflow_draft` exactly once and surface
  its structured human gate.
- **Force-committing without surfacing the override to the operator.** If the
  operator explicitly chooses to commit despite a failed `dry_run_workflow`
  or a blocking judge verdict, emit `ask_user_confirm` with
  `commit_intent.payload.force_commit: true`. The harness prepends an
  override warning to the summary and a single confirmation suffices — do
  NOT retry through a second `ask_user_confirm` after a "preview_failed"
  result. The same pattern applies to `save_connector_draft` with
  `force_save: true` after a failed probe.
- **Confusing `output_transform` with `data_selector`.** `output_transform` runs
  once, at the end. `data_selector` runs per step. Using `output_transform` to
  trim an early step wastes scope space for the whole run.
- **Chasing escaped quotes inside `output_transform` as a "bug".** A `\"` (or a
  stored DAG showing `\\\"`) inside a JSONata `output_transform` is the normal,
  valid JSON encoding of a quote — JSONata accepts it and the runtime evaluates it
  correctly. It is cosmetic, not a defect. Do **not** burn version bumps
  `edit_workflow_patch`-ing the escaping back and forth. Only re-author the
  transform when a dry-run actually reports wrong output or an
  `unresolved_identifier` / `placeholder_unresolved` warning.
- **Nested loop id collisions.** `loop.body[].id` values must be unique across
  the whole workflow, not just within the body. The validator rejects duplicates.
- **Writing JSONata that assumes arrays.** `$scope.foo.data.items` when `items`
  is missing returns `undefined`, which then blows up downstream. Guard with
  `$scope.foo.data.items ? $scope.foo.data.items : []` (in JS:
  `input.scope.foo.data.items ?? []`).
- **Expecting `call` to inherit parent scope.** A called workflow starts with a
  fresh scope; it only sees what's passed through `config.input`.

## See also

- `sk-concepts.md` — the envelope and placeholder tokens.
- `data-handling.md` — JSONata cheatsheet and reshaping patterns.
- `error-recovery.md` — recovering from tool errors mid-conversation.
