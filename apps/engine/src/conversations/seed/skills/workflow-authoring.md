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
6. **`commit_draft`** — once all steps run green and the outputTransform shape
   matches the intent, commit. Commits are cheap; runs are where governance kicks in.

For request steps, use the current flattened shape: `connector_id`, `method`,
`path`, `query`, `headers`, `body`, and `graphql` live directly on the step.
Do not wrap them in `config`.

## Repair-in-chat: failed run → diagnose → recommit

A persisted workflow that fails on its next run does NOT need a new draft from
scratch. The conversation enters diagnosis mode and the same six tools repair
it in place — the operator never leaves chat.

1. **Read the failure** — the `run_workflow` result carries `ok: false` plus a
   structured error envelope (`error.code`, `error.message`, the failing
   `step_id`, captured response shape). Do not paraphrase the error away; the
   user needs to see the actual code so they understand what changed.
2. **`diagnose_latest_execution`** — pulls the run's full causal trace and
   surfaces a `latest_diagnosis` block on the draft. This is the source of
   truth for repair targets; do not guess from the bare error.
3. **Edit the offending step** — use `update_param` for a single field
   (connector swap, header rename, response_schema tweak), `propose_step` to
   replace a step body, or `connect_steps` to retarget references. For a
   schema drift on a request step, run `probe_connector` first to capture the
   current shape, then update the step's `response_schema` / `data_selector`.
4. **`validate_draft`** — re-runs the structural checks. Skipping this is the
   most common reason a re-commit fails: a fix that compiles but breaks
   another reference upstream is invisible until validation re-runs.
5. **`dry_run_workflow`** (or `dry_run_step` for the touched step only) — only
   needed before the FIRST commit of a brand-new draft; for an in-place
   re-commit after `validate_draft` is fresh, the palette already exposes
   `commit_draft` and the engine accepts the update without a fresh preview.
   Use a dry-run when the change is non-trivial enough that the operator
   should see the new shape before committing.
6. **`ask_user_confirm(kind: "commit_draft")` → `commit_draft`** — confirm,
   then save. `commit_draft` updates the persisted workflow in place when the
   conversation already targets one (it appends a new version; the slug stays
   authoritative). There is no separate "commit a repair" tool and there is
   no CLI fallback — the chat path is the only path.

Hard rules during repair:
- Do NOT instruct the user to run `sk workflow commit` or any other CLI
  command. The same `commit_draft` tool that creates new workflows also
  updates persisted ones.
- Do NOT re-run the failed workflow before re-validating. The diagnosis is
  pinned to the prior run; re-running first overwrites it and you lose the
  cheapest source of repair signal.
- Do NOT silently skip failing steps with `if: false` or fallback values
  unless the user explicitly asks for that behaviour. Repair the step.

After three failed repair iterations on the same error code, stop and ask
the user. You have probably misread the failure mode.

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

## `data_selector` vs transform step vs `outputTransform`

Three places you can reshape data. Each has a different purpose:

| Where | Scope | When to use |
|---|---|---|
| Step-level `data_selector` | Trims what this step's `.data` looks like to **downstream** | Drop heavy fields (full HTML bodies, base64 blobs) early so scope stays small |
| Dedicated `transform` step | Produces a new step with its own envelope | Reshape across multiple upstream steps, or compute derived values |
| Workflow-level `outputTransform` | The final payload the caller sees | Hide internal plumbing, expose only the contract |

Example combining all three:

```json
{
  "steps": [
    {
      "id": "fetch_orders",
      "kind": "request",
      "connector_id": "00000000-0000-0000-0000-000000000001",
      "method": "GET",
      "path": "/admin/api/2024-04/orders.json",
      "data_selector": "$.orders.{ 'id': id, 'total': total_price, 'customer_email': email }"
    },
    {
      "id": "fetch_customers",
      "kind": "request",
      "connector_id": "00000000-0000-0000-0000-000000000002",
      "method": "GET",
      "path": "/crm/v3/objects/contacts",
      "data_selector": "$.results.{ 'email': properties.email, 'lifecycle': properties.lifecyclestage }"
    },
    {
      "id": "merge",
      "kind": "transform",
      "expression": "$scope.fetch_orders.data.{ 'order_id': id, 'total': total, 'lifecycle': $scope.fetch_customers.data[email = $$.customer_email].lifecycle }",
      "language": "jsonata"
    }
  ],
  "output_transform": "{ 'report': $scope.merge.data, 'generated_at': $now() }"
}
```

`data_selector` trimmed the Shopify response from ~40 fields to 3, keeping scope
small. The `merge` transform joined the two lists by email. `outputTransform`
added a timestamp envelope for the caller.

## `input_schema` vs `input_schema_sample`

- **`input_schema`** — a JSON Schema. The engine validates workflow input against
  it before the first step runs. Use when the shape is stable and the caller is
  a trusted connector boundary (another workflow, a webhook with a known contract).
- **`input_schema_sample`** — a literal example payload. Used for dev-time
  dry-runs and LLM context; **not** enforced at runtime. Use when the shape is
  still evolving and over-constraining would slow down iteration.

Both can coexist. A common pattern:

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
item as a **top-level scope key** named by `item_var` (defaults to `item`).
The item is NOT envelope-wrapped — reference it as `${user.field}` or
`$user.field`, never `$scope.user.data.field`. See the "Loop iteration
variables" section in `data-handling.md` for the four wrong shapes the
validator rejects.

```json
{
  "id": "send_emails",
  "kind": "loop",
  "over": "$scope.segment.data.users",
  "body": ["send"],
  "item_var": "user"
}
```

Body step referencing the item:

```json
{
  "id": "send",
  "kind": "request",
  "method": "POST",
  "path": "/mail",
  "body": { "to": "${user.email}", "name": "${user.name}" }
}
```

`$loop_index` (zero-based) is also available inside the loop body.

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
    "over": "$scope.extract_projects",
    "item_var": "project",
    "body": ["get_project_resources"]
  },
  {
    "id": "get_project_resources",
    "kind": "request",
    "method": "GET",
    "connector_id": "<digitalocean_connector_id>",
    "path": "/v2/projects/${project.id}/resources"
  },
  {
    "id": "format_output",
    "kind": "transform",
    "language": "jsonata",
    "expression": "$scope.fetch_resources.{ \"project\": project.name, \"resources\": $.resources }"
  }
]
```

Three things this example gets right that the LLM frequently gets wrong:
1. The inner step (`get_project_resources`) **uses `${project.id}`** in the
   path. Without that, the loop is N copies of the same call. The validator
   rejects loop bodies that never reference `item_var`.
2. The loop iterates over a **plain array** (the output of
   `extract_projects`), not a step envelope. `$scope.extract_projects.data`
   would be wrong — `extract_projects` is a transform, its raw return value
   IS the scope value.
3. The final transform reads from `$scope.fetch_resources` (an array of
   per-iteration outputs), with the loop's `item_var: "project"` still
   bound — the closure lets the format step join the project name with its
   resources.

### Unresolved-identifier warnings are never false positives

If `dry_run_workflow` or `run_workflow` returns a warning of code
`unresolved_identifier`, the workflow is **broken**, not "warned". The
runtime parsed your JSONata and could not bind one of the names you
referenced. Common causes:

- You used `$scope.fetch_X.data` for a `transform` step's output — but
  transforms don't envelope. Drop the `.data`.
- You referenced `id` / `name` as bare names but no prior step is named
  `id` or `name` and you are not inside a loop body where `item_var` is
  one of those.
- You typo'd a step id (`$scope.fetcch_projects`).
- You used `$$` to "fix" the JSONata when you actually wanted
  `$scope.<step_id>` or the loop's item.

The `commit_workflow_draft` tool refuses to advance until the warning is
gone or the operator explicitly forces with `force_commit: true`. Do
not tell the user "this is a false positive" — the engine surfaces these
warnings precisely because they are not.

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

Every `transform` step with `language: "javascript"` and every before-request
hook runs inside QuickJS with a curated `sk` global already installed. Use it
instead of re-implementing the same helpers inline — the surface is frozen,
versioned, and deterministic (no `Date.now`, no `Math.random`, no host I/O).

| Call | Purpose |
|---|---|
| `sk.http.isMutating(method)` / `sk.http.isSafe(method)` | Classify HTTP methods without typo-prone string lists |
| `sk.http.METHODS.READ` / `sk.http.METHODS.WRITE` | Pre-baked method arrays |
| `sk.get(obj, "a.b.c", fallback)` / `sk.has(obj, path)` | Null-safe property access |
| `sk.allow()` / `sk.deny(reason)` | Canonical decision shapes for hooks |
| `sk.pick(obj, keys)` / `sk.omit(obj, keys)` | Shape-preserving subset / exclusion |
| `sk.pluck(arr, key)` / `sk.groupBy(arr, keyOrFn)` / `sk.uniq(arr)` | Common array reshapers |
| `sk.isString / isNumber / isArray / isObject / isNil` | Type guards |
| `sk.version` | Stdlib version — persisted on workflows for drift detection |

Prefer the stdlib over raw comparisons so hook and transform code stays
uniform. Example: write

```js
return sk.http.isMutating(sk.get(input, "request.method", ""))
  ? sk.deny("mutating_denied")
  : sk.allow();
```

rather than

```js
var m = (input && input.request && input.request.method) || "";
if (m === "POST" || m === "PUT" || m === "PATCH" || m === "DELETE") {
  return { allow: false, reason: "mutating_denied" };
}
return { allow: true };
```

Both are correct; the stdlib form is the one the authoring layer proposes.

## Common pitfalls

- **Skipping `probe_connector`.** You'll spend five turns debugging a credential
  that never existed. Probe first, every time.
- **Committing before every step has a green dry-run.** `commit_draft` doesn't
  run the steps. Bad drafts commit cleanly and then fail at first invocation.
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
