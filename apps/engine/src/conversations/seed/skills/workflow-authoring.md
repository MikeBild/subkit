---
slug: workflow-authoring
scope: global
title: Authoring Workflows In A Conversation
description: The canonical recipe for turning a user intent into a committed subkit workflow draft.
gates_tools: []
version: 1
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
6. **`ask_user_confirm` with `commit_intent`** — once all steps run green and
   the outputTransform shape matches the intent, surface a single
   `ask_user_confirm` carrying
   `commit_intent: { kind: "commit_workflow_draft", payload: { … }, description: "Save this workflow." }`.
   The harness atomically persists on confirm and injects a synthetic
   `commit_draft` tool-result tagged `source: "harness_auto_persist"`. **Do
   NOT call `commit_draft` yourself afterward** — the underlying write has
   already happened, and a second call only earns an `already_persisted: true`
   round-trip. Reserve direct `commit_draft` invocations for the documented
   recovery paths (revert + re-apply, slug-conflict adoption, force-commit
   after a failed dry-run).

For request steps, use the current flattened shape: `connector_id`, `method`,
`path`, `query`, `headers`, `body`, and `graphql` live directly on the step.
Do not wrap them in `config`.

## Repair-in-chat: failed run → diagnose → recommit

A persisted workflow that fails does NOT need a new draft. Stay in
chat; the same six tools repair in place:

1. **Read the failure** — the `run_workflow` result has `error.code`,
   `error.message`, failing `step_id`, captured response shape. Do not
   paraphrase the error away.
2. **`diagnose_latest_execution`** — pulls causal trace; do not guess from the bare error.
3. **Edit the offending step** — `update_param` for a single field, `propose_step` to replace a step body, `connect_steps` to retarget. For schema drift on a request step, `probe_connector` first.
4. **`validate_draft`** — re-runs structural checks.
5. **`dry_run_workflow`** when the change is non-trivial; otherwise the auto-persist path accepts the update directly.
6. **`ask_user_confirm` with `commit_intent: { kind: "commit_workflow_draft", payload: { target_workflow_id?: <id> } }`** — harness persists on confirm. Do NOT chain a separate `commit_draft` after.

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
- **`output_transform`** — workflow-level final payload the caller sees (hide internals).

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

**HTTP / placeholder substitution** (path, url, headers, query, body): use
`${item.<path>}`. This is the only form the runtime placeholder resolver
accepts — `${user.field}` or `${project.id}` will fail with
`placeholder_unresolved` because `user` / `project` are not registered
placeholder kinds.

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

The `commit_workflow_draft` tool refuses to advance until the warning is
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
- **Committing before every step has a green dry-run.** The
  `commit_intent` auto-persist path doesn't run the steps. Bad drafts commit
  cleanly and then fail at first invocation.
- **Calling `commit_draft` directly instead of via `ask_user_confirm` +
  `commit_intent`.** Direct `commit_draft` calls are policy-gated and the
  inner prior-approval check rejects with `no_prior_approval` until a
  resolved `ask_user_confirm{kind:"commit_draft", confirmed:true}` exists.
  Always go through `ask_user_confirm` with a `commit_intent` carrier;
  reserve direct `commit_draft` for the recovery cases (revert + re-apply,
  slug-conflict adoption, force-commit after a failed dry-run).
- **Force-committing without surfacing the override to the operator.** If the
  operator explicitly chooses to commit despite a failed `dry_run_workflow`,
  emit `ask_user_confirm` with
  `commit_intent.payload.force_commit: true`. The harness prepends an
  override warning to the summary and a single confirmation suffices — do
  NOT retry through a second `ask_user_confirm` after a "preview_failed"
  result. The same pattern applies to `save_connector_draft` with
  `force_save: true` after a failed probe.
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

- `subkit-concepts.md` — the envelope and placeholder tokens.
- `data-handling.md` — JSONata cheatsheet and reshaping patterns.
- `error-recovery.md` — recovering from tool errors mid-conversation.
