---
slug: workflow-authoring
scope: global
title: Authoring Workflows In A Conversation
description: The canonical recipe for turning a user intent into a committed sk workflow draft.
activates_when: [{"kind":"tool","tool":"build_workflow"},{"kind":"tool","tool":"approve_discovery_artifact"},{"kind":"tool","tool":"preview_attachment"}]
side_effects: read
idempotency: none
maturity: stable
tags: [authoring, workflow]
version: 5
---

# Authoring Workflows In A Conversation

This skill describes the happy path for building a workflow when the user is
talking to you in a conversation. Follow the phases in order; skipping them
produces drafts that fail at runtime or in review.

## The six-phase flow

1. **`get_engine_status`** — confirm the engine is up, the tenant is resolved,
   and you're in the right environment. Fail fast here.
2. **`list_connectors`** — see what's already wired. The user rarely volunteers
   that "we already have a HubSpot connector called `hubspot_prod`", but it's
   almost always true.
3. **`probe_connector`** — for each connector you plan to use, verify the
   credential resolves and the base URL responds. This catches 80% of
   `placeholder_unresolved` and `http_4xx` errors before they become workflow bugs.
4. **`load_skill`** — pull the driver-specific skill (`http-connectors`,
   `postgres-connectors`, `s3-connectors`, `graphql-connectors`) plus any domain
   skills the tenant has seeded. Read them fully before proposing steps.
5. **`propose_step`** (incremental) or **`build_workflow`** (one-shot) — emit step
   drafts. Each `propose_step` returns a dry-run result you can inspect; if a
   step's envelope doesn't match what downstream expects, edit before moving on.
6. **`dry_run_workflow` (auto-commits on green)** — once all steps run green and
   the outputTransform shape matches the intent, call `dry_run_workflow`. A
   clean preview (status `succeeded`, no `requires_repair` warnings) is the
   workflow's persistence trigger: `commitWorkflowAtomic` runs inline with
   `reason: "auto_persist_on_green_dry_run"` and the same envelope returns the
   committed shape (`auto_committed: true`, `workflow_id`, `version`,
   `step_trace`). **Do NOT call `save_workflow_draft` yourself afterward** —
   the underlying write has already happened, and a second call only earns an
   `already_persisted: true` round-trip. Reserve direct `save_workflow_draft`
   invocations for the documented recovery paths (revert + re-apply,
   slug-conflict adoption, force-commit after a failed dry-run).

   The legacy `ask_user_confirm` + `commit_intent: save_workflow_draft` carrier
   is no longer needed for the happy path. Use it only when the operator
   explicitly opts to commit despite a failed dry-run (force-commit) — see
   "Force-commit override" below.

   There is no separate publish step. A green dry-run is the save: the
   workflow is immediately live as the new version. If the user asks to
   "commit", "push", "deploy", or "publish" after a green preview, do not
   invent an action — tell them it is already live as v<N> and offer a real
   next step (run it, bind a schedule or trigger, or keep editing).

For request steps, use the current flattened shape: `connector_id`, `method`,
`path`, `query`, `headers`, `body`, and `graphql` live directly on the step.
Do not wrap them in `config`.

## Recurring cadence is part of the workflow definition

If the user's goal phrases a cadence — examples below — the workflow
**MUST** carry a `trigger: { kind: "schedule", cron, tz }` field. The
schedule binding is part of the workflow definition, not a separate
call. `build_workflow` accepts the trigger directly; on commit
`applyTriggerBindings` upserts the `workflows_schedules` row and emits
the `schedule.trigger.bound` audit event. **Do not call
`create_schedule` separately for a brand-new workflow** — that path is
for binding a cron to an already-saved workflow, and creating a
parallel binding without the workflow's own `trigger` field leaves the
two out of sync.

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
chat; the same six tools repair in place:

1. **Read the failure** — the `run_workflow` result has `error.code`,
   `error.message`, failing `step_id`, captured response shape. Do not
   paraphrase the error away.
2. **`diagnose_latest_execution`** — pulls causal trace; do not guess from the bare error.
3. **Edit the offending step** — `update_param` for a single field, `propose_step` to replace a step body, `connect_steps` to retarget. For schema drift on a request step, `probe_connector` first; if the connector's response shape changed over time, call `propose_schema_migration` (returns a structured rename/add/remove/widen plan against the recorded shape ledger) before deciding how to patch the transform.
4. **`validate_draft`** — re-runs structural checks.
5. **`dry_run_workflow`** — green dry-run auto-commits the patched workflow inline (`auto_committed: true`, audit reason `auto_persist_on_green_dry_run`). No separate confirmation step. Skip dry-run only for trivial parameter tweaks where the auto-persist on update suffices; any structural change must run dry-run first.

Do not instruct the user to run `sk workflow commit` (no CLI fallback exists). Do not re-run the failed workflow before re-validating (overwrites the diagnosis). Do not skip failing steps with `if: false` unless the user asks for that behaviour. After three failed repair iterations on the same error, stop and ask the user.

## `propose_step` vs `build_workflow`

| Question | Use `build_workflow` | Use `propose_step` (one per step) |
|---|---|---|
| Does the user know the full shape up-front? | Yes | No, we're exploring |
| Are all connectors already probed and green? | Yes | Some may need discovery |
| More than 5 steps, or any loop/branch/parallel? | Prefer incremental anyway | Yes |
| User has pasted a schema or example payload? | Yes, one-shot is faster | Either |

Rule of thumb: **default to `propose_step`**. The round-trip of seeing each
envelope prevents compounding errors. Reserve `build_workflow` for trivial
linear 2–4 step workflows where the user has given you an example payload.

## Reshape locations

Three places to reshape data — pick the smallest one that fits:

- **Step-level `data_selector`** — trim a step's `.data` for downstream consumers (drop heavy fields).
- **`transform` step** — reshape across multiple upstream steps, or compute derived values.
- **`output_transform`** (JSONata) or **`output_transform_function`** (JS) — workflow-level final payload the caller sees (hide internals). Pick exactly one — the schema rejects setting both. JSONata is the default; reach for the JS form via QuickJS sandbox only when the reshape needs imperative logic, mutation, or multi-pass scans JSONata can't express. Same affordance pattern as `validation_expression` (JSONata) vs `validation_function` (JS).

See `data-handling.md` for full examples.

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

Iterate over an array from a prior step. Each iteration exposes the current
item under two scope keys: `$item` (canonical, used by `${item.…}`) and the
loop's `item_var` (used by JSONata transforms). The item is NOT
envelope-wrapped.

**Mandatory: dry-run before authoring a loop.** `propose_step`,
`build_workflow`, `edit_workflow_patch`, and `update_param` all
refuse a loop step that reads `$scope.<X>` (or the equivalent bare
form `<X>.data`) until a dry-run has recorded X's actual output
shape (error code `loop_authoring_requires_inspect`). The fix: call
`dry_run_workflow` first so the engine publishes `scope_at_step` for
every prior step. Then call `suggest_jsonata_paths` (returns ranked
path candidates against the recorded preview, with fallback to the
last committed version's `scope_index` and the most recent execution
when no fresh draft preview exists) or `inspect_workflow_draft`
(returns each step's preview side-by-side with config). Authoring a
loop's `over` against the LLM's mental model of the API instead of
the recorded preview is how 4–9× retry spirals start; the gate
exists to break that loop deterministically.

**Same rule for `transform` steps.** A transform whose `expression`
cites `$scope.<X>` for an un-previewed sibling X is rejected with
error code `transform_authoring_requires_inspect`. Same four tools
enforce it (`propose_step`, `build_workflow`, `edit_workflow_patch`,
`update_param`). Same fix: `dry_run_workflow` once, then author the
transform against the recorded `output_preview` (visible via
`inspect_workflow_draft` or surfaced inline in the authoring context
as `$item.{ id, name, ... } (sampled from preview)` when the
transform's source is the body of a loop). Hard-coding placeholder
strings (`"item 1"`, `"unknown"`) as JSONata defaults to dodge the
gate is forbidden — that's how the "succeeded with garbage output"
transcript happened (`get-last-3-gmail-messages with human output`).

**Iterating on a transform — prefer `dry_run_transform`.** Once a green
`dry_run_workflow` has recorded the upstream step's `output_preview`,
further edits that only touch a transform's `expression` should call
`dry_run_transform` — *not* `dry_run_workflow`. `dry_run_transform`
evaluates JSONata against the recorded sample without re-hitting the
network, so a transform debug loop costs O(1) ms per iteration instead
of O(s) and avoids burning vendor rate-limit on the same upstream call
twelve times in a row. Pass the previewed scope path (e.g.
`$scope.fetch_issues`) as `sample_data`; the tool resolves it from the
latest cached dry-run. Only fall back to `dry_run_workflow` when you
actually change a request/connector/loop step, or after several green
transform iterations to confirm end-to-end.

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

**`build_workflow` returns `persistence: "draft_only"` and
`next_step: "save_workflow_draft"`.** The build never auto-saves — the
fields make this explicit so the LLM never assumes a workflow is
committed after `build_workflow`.

**Scope vocabulary survives commits.** After every successful run
the engine writes `step_id → scope_at_step` to
`workflow_versions.scope_index`. Repair-author sessions opening
months later have `suggest_jsonata_paths` populated from this
persisted vocabulary even before the first dry-run.

**`loop.over`** is JSONata evaluated with the same bindings as
`transform.expression`: `$input`, `$scope`, `$steps`, and unpacked
`$<key>` bindings. Both forms below are equivalent — pick whichever
reads better:

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

### Authoring order — body steps before the loop

When you add a `loop` step whose `body: ["A", "B"]` references steps A
and B, propose `A` and `B` **first**, then propose the loop. The
incremental draft validator now accepts forward references on
`loop.body` / `branch.then_steps` / `parallel.branches[]` (it returns
them as `pending_forward_refs` so you can see what's missing), but
`dry_run_workflow` and `save_workflow_draft` still reject the draft
until every referenced id exists. Order matters for two reasons:

1. The `loop` requires `${item.<field>}` placeholders inside its body
   step's URL / path / headers / body. Author the body step with the
   real placeholders so the loop's `item_var` semantics surface
   immediately on the next preview — no second authoring round-trip.
2. Body-first matches the data-flow direction: the body fetches a
   resource, the loop iterates the parent collection. Reading the
   workflow top-down should follow producer → consumer.

If you find yourself thinking "I'll add the loop and fill in the body
next," stop and write the body step first instead. The reference impl
ships the whole tool at once via `build_tool`; sk's incremental
flow now tolerates the dependency-inverted shape, but the author who
writes body-then-loop is shorter by 1–2 round-trips and never sees a
red `unknown loop body target` banner.

**JSONata transforms** (`expression`): use the bare `item_var` name —
JSONata reads it from the scope object, e.g. `user.email` or
`project.name`.

```json
{
  "id": "send_emails",
  "kind": "loop",
  "over": "$scope.segment.data.users",
  "body": ["send"],
  "item_var": "user"
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

### Loop output shape

`$scope.<loop_id>.data` is an array of iteration objects, each keyed
by body step id with a full ScopeEnvelope inside. Path to a body field:
`$scope.<loop_id>.data.<body_step_id>.data.<field>`.

To project across iterations, use `$map(loop_id.data, function($iter, $i) {...})`
inside a transform; `$iter.<body_step_id>.data` is the response payload. If
fewer keys come out than went in, a `transform_dropped_fields` warning fires
(informational only — see "Repair signal" below).

Debugging — call `inspect_workflow` (multi-step) or
`inspect_execution_step` (single step from a prior run) to read the real
shape before authoring the next projection. Do not guess at JSONata.

### Worked example: list DigitalOcean projects + their resources

This is the canonical pattern when a user asks for "list every X with its
resources / children / details." Copy-paste it; do not invent variants.

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
    "language": "jsonata",
    "expression": "$scope.fetch_projects.data.projects.{ \"id\": id, \"name\": name }"
  },
  {
    "id": "fetch_resources",
    "kind": "loop",
    "over": "$scope.extract_projects.data",
    "item_var": "project",
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
    "language": "jsonata",
    "expression": "$scope.fetch_resources.data.{ \"project\": project.name, \"resources\": get_project_resources.data.resources }"
  }
]
```

Four rules this example encodes:
1. Loop body uses `${item.id}` in HTTP placeholders (NOT `${project.id}`). The placeholder resolver only accepts `cred|connector|input|scope|item`; `${project.id}` becomes `placeholder_unresolved`.
2. **EVERY step output is uniformly enveloped** as `{data, status_code?, headers?, duration_ms, error}` — including `transform` and `loop`. The loop's `over` reads `$scope.extract_projects.data` (the array), not `$scope.extract_projects` (the envelope). See `data-handling.md`.
3. Loop output is at `$scope.<loop_id>.data.<body_step_id>.data` (envelope-in-envelope). JSONata reads `project.name` (the bare loop item) directly from scope, not via placeholder resolver.
4. `${item.…}` for path/url/headers/query/body strings; `item_var` (e.g. `project`) for JSONata expressions. Mixing surfaces as `placeholder_unresolved` or `unresolved_identifier`.

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
    "item_var": "project",
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
    "language": "jsonata",
    "expression": "$scope.fetch_resources.data.get_project_resources.data.resources.{ \"urn\": urn, \"path\": $substring(links.self, $length('https://api.digitalocean.com')) }"
  },
  {
    "id": "expand_resource",
    "kind": "loop",
    "over": "$scope.flatten_links.data",
    "item_var": "resource",
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
    "language": "jsonata",
    "expression": "$scope.expand_resource.data.{ \"urn\": resource.urn, \"details\": fetch_resource_detail.data }"
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

### Unresolved-identifier warnings are never false positives

If `dry_run_workflow` or `run_workflow` returns a warning of code
`unresolved_identifier`, the workflow is **broken**, not "warned". The
runtime parsed your JSONata and could not bind one of the names you
referenced. Common causes:

- You wrote `$scope.fetch_X` (no `.data`) — that is the envelope, not the
  payload. Add `.data`. **Every step has the same envelope shape, including
  transforms and loops.**
- You referenced `id` / `name` as bare names but no prior step is named
  `id` or `name` and you are not inside a loop body where `item_var` is
  one of those.
- You typo'd a step id (`$scope.fetcch_projects`).
- You used `$$` to "fix" the JSONata when you actually wanted
  `$scope.<step_id>.data` or the loop's item.

The `save_workflow_draft` tool refuses to advance until the warning is
gone or the operator explicitly forces with `force_commit: true`. Do
not tell the user "this is a false positive" — the engine surfaces these
warnings precisely because they are not.

## Authoring recipe (mandatory order before `build_workflow` / `propose_step`)

Skipping any of these steps produces a draft authored against a guessed
shape that fails at runtime. Follow the order:

1. **Load skills.** `load_skill` for `data-handling` plus the relevant
   protocol skill(s) (`http-connectors`, `postgres-connectors`,
   `s3-connectors`, `graphql-connectors`) and any domain skill the tenant
   has seeded.
2. **`list_connectors`.** Note `id`, `slug`, `base_url`, stored credentials.
3. **`probe_connector`.** Verify credential resolves and base URL responds.
4. **`search_docs` and `search_knowledge`.** Look up endpoints, auth,
   pagination, response structure. Do not guess paths from the URL.
5. **`call_connector`.** Execute one or two primary endpoints and
   capture the real response shape. Author against THAT shape, not what
   you remember from another vendor.
6. **Only then** call `build_workflow` or `propose_step`. Reference
   captured fields by `$scope.<step>.data.<path>`.

When in doubt, load more skills rather than fewer.

## Five consecutive failures → ask the user

Never make more than **five failed tool calls in a row** without asking
the user. A "failed tool call" is any `tool_result` with `ok: false`,
or `dry_run_workflow` / `run_workflow` whose `status` is `failed` or
whose `requires_repair` is `true`. The counter resets on the first
successful tool call.

When the cap is reached, emit `ask_user_choice` with three concrete
options derived from the failure shape (e.g. "commit anyway", "revert
the last patch", "hand-edit the workflow JSON"). Do not continue patching.

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

When a step's output looks wrong, do NOT guess at JSONata. Call
`inspect_workflow` to read the captured shape of every step from the
most recent run, then author the next patch against the returned shape.
Use this BEFORE the third `update_param` on the same field —
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
- `sk.isString / isNumber / isArray / isObject / isNil` — type guards
- `sk.version` — stdlib version (persisted for drift detection)

Prefer the stdlib over raw comparisons so hook + transform code stays uniform.

## Common pitfalls

- **Skipping `probe_connector`.** You'll spend five turns debugging a credential
  that never existed. Probe first, every time.
- **Skipping `dry_run_workflow` and reaching for `save_workflow_draft`
  directly.** Direct `save_workflow_draft` calls are policy-gated and the inner
  prior-approval check rejects with `no_prior_approval`. The persistence
  contract is: green dry-run = inline auto-commit. If the dry-run is failing,
  the workflow needs a fix, not a force-commit.
- **Calling `save_workflow_draft` after a green `dry_run_workflow`.** The
  green-dry-run envelope already returns `auto_committed: true`; a subsequent
  `save_workflow_draft` only earns an `already_persisted: true` round-trip.
  Read `auto_committed` and report the saved outcome to the user.
- **Force-committing without surfacing the override to the operator.** If the
  operator explicitly chooses to commit despite a failed `dry_run_workflow`,
  emit `ask_user_confirm` with `commit_intent.payload.force_commit: true`. The
  harness prepends an override warning to the summary and a single
  confirmation suffices — do NOT retry through a second `ask_user_confirm`
  after a "preview_failed" result. The same pattern applies to
  `save_connector_draft` with `force_save: true` after a failed probe.
- **Confusing `output_transform` with `data_selector`.** `output_transform` runs
  once, at the end. `data_selector` runs per step. Using `output_transform` to
  trim an early step wastes scope space for the whole run.
- **Nested loop id collisions.** `loop.body[].id` values must be unique across
  the whole workflow, not just within the body. The validator rejects duplicates.
- **Writing JSONata that assumes arrays.** `$scope.foo.data.items` when `items`
  is missing returns `undefined`, which then blows up downstream. Guard with
  `$scope.foo.data.items ? $scope.foo.data.items : []`.
- **Expecting `call` to inherit parent scope.** A called workflow starts with a
  fresh scope; it only sees what's passed through `config.input`.

## See also

- `sk-concepts.md` — the envelope and placeholder tokens.
- `data-handling.md` — JSONata cheatsheet and reshaping patterns.
- `error-recovery.md` — recovering from tool errors mid-conversation.
