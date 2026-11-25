---
slug: workflow-authoring-structures
scope: global
title: Workflow Loops, Fan-Out And Branches
description: Multi-step structures: bulk list over per-item loops, inline `for_each` fan-out, bounded traversal of nested data, the `for_each` addressing table, branches, parallel, and JSONata flavour rules.
activates_when: [{"kind":"step_kind","step_kinds":["loop","branch","parallel"]},{"kind":"intent_keyword","word":"for_each"},{"kind":"intent_keyword","word":"for each"},{"kind":"intent_keyword","word":"für jede"},{"kind":"intent_keyword","word":"für jeden"},{"kind":"intent_keyword","word":"schleife"},{"kind":"intent_keyword","word":"iterate"},{"kind":"intent_keyword","word":"iterier"},{"kind":"intent_keyword","word":"fan-out"},{"kind":"intent_keyword","word":"nested"},{"kind":"intent_keyword","word":"verschachtelt"},{"kind":"intent_keyword","word":"parallel"},{"kind":"intent_keyword","word":"verzweig"}]
side_effects: read
idempotency: none
maturity: stable
tags: [authoring, workflow, orchestration]
version: 1
---

# Workflow Loops, Fan-Out And Branches

## Design rule: prefer one bulk list endpoint over a nested per-item loop

When the vendor offers a list endpoint that returns the collection with
the fields the goal needs, fetch it ONCE and reshape with a single
transform. Reach for a loop over a per-item detail endpoint only when the
list payload genuinely lacks a required field. One bulk call + one
transform beats N detail calls on every axis: fewer steps, fewer failure
modes, no rate-limit pressure, and the recorded sample covers the whole
shape.

## `for_each` — inline per-step iteration

Any step (request, transform, call, wait) can declare a `for_each` field
on `baseStep`. It is the only way to iterate: there is no `loop` step
kind, no body array and no sibling step ids — just ONE step that runs
once per element.

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
  (zero-based) into the substitution scope.
- Inside the step's `path`/`url`/`headers`/`query`/`body` strings: use
  `${item.<field>}`.
- Inside JSONata `data_selector` on the SAME step: use `$item.<field>`.
- The step output is an array of envelopes (one per iteration), keyed by
  iteration index: `$scope.<step_id>.data[i]`.

**Several actions per element — which shape:**

| Situation | Use |
|---|---|
| One step per item | `for_each` on the step |
| Each item needs several ordered steps | a `call` step with `for_each` that runs a child workflow holding those steps, or consecutive `for_each` steps where each one reads the previous step's per-item results |
| HATEOAS expansion needing two sequential passes | Two flat `for_each` steps separated by a transform |

**Parallelism — independent reads fan out.**

- A `for_each` over a **read** request (GET / GraphQL query / SQL SELECT /
  S3 GET·HEAD·LIST) runs its iterations **concurrently** with a bounded
  pool (default 8). N independent reads cost ~1 roundtrip of wall-clock,
  not N. This is automatic — you do not declare anything.
- **Writes** (POST/PUT/PATCH/DELETE, mutations) stay **sequential** by
  default — firing writes in parallel without intent is unsafe. Opt in
  deliberately with `for_each_concurrency: <N>` on the step ONLY when the
  writes are truly independent.
- Tune an explicit bound with `for_each_concurrency` (integer ≥ 1; `1`
  forces sequential). Lower it when the upstream API rate-limits hard.

**Addressing `for_each` output downstream (after the step):**

- JS transform: `input.scope.<step_id>.data.map(iter => iter.<step_id>.data.<field>)`
- JSONata: `$scope.<step_id>.data.<step_id>.data.<field>`

A step with `for_each` is NOT a container — it is a regular step that
the runtime expands inline.

## Nested / tree data — traverse it, don't silently flatten

Some APIs return a TREE, not a flat list: Notion page blocks
(`/blocks/{id}/children`, where any block with `has_children: true` has
its own children one fetch deeper), a file/folder hierarchy, an org →
teams → members chain, threaded comments. `for_each` **does not
nest**, so you cannot recurse to unbounded depth in one workflow. Two
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

**The bounded-depth pattern (no nested iteration):**

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

## Multi-step structures

### Iteration

A step with `for_each` runs once per element of an array from a prior
step. Each iteration exposes the current item as `$item` (JSONata) /
`${item.…}` (request strings), plus `$loop_index` (zero-based). The item
is NOT envelope-wrapped.

`for_each` selectors and transform edits are gated by recorded preview evidence; `workflow-authoring-repair` covers the gate and its one-round-trip recovery.

**`for_each`** is a JavaScript arrow function over the run scope:
`(sourceData) => sourceData.<step_id>.data.<array_path>`. It is not a
placeholder and not JSONata — `${…}` and `$scope.…` are rejected there.

**`branch.when`** is JSONata — `$scope.<step_id>.data.field`
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
`{{ project.id }}` are all wrong — the only correct form for the current
item inside a string field is `${item.id}`. The draft validator rejects
Mustache shapes with code `workflow_unsupported_placeholder` and a
concrete `did_you_mean` rewrite, so never propose a Mustache
placeholder.

### Iteration shape

```json
{
  "id": "send",
  "kind": "request",
  "for_each": "(sourceData) => sourceData.segment.data.users",
  "method": "POST",
  "path": "/mail",
  "body": { "to": "${item.email}", "name": "${item.name}" }
}
```

`$loop_index` (zero-based) is also available inside the step.

### Inside a `for_each` step — addressing table

Item addressing is the single most common source of authoring churn.
There are exactly two expression surfaces and each accepts exactly one
form — mixing them surfaces as `placeholder_unresolved` or
`unresolved_identifier`:

| You need | JSONata expressions (`data_selector`, `branch.when`) | Request placeholder strings (`path` / `url` / `headers` / `query` / `body`) |
|---|---|---|
| Current item field | `$item.name` (the ONLY form — bare item names are rejected) | `${item.name}` |
| Iteration index (zero-based) | `$loop_index` | not available — derive it in a prior transform if needed |
| An earlier step's result | `$scope.<step_id>.data.<field>` | `${scope.<step_id>.data.<field>}` |
| This step's output downstream (AFTER it ran) | `$scope.<step_id>.data.<step_id>.data.<field>` | prefer a transform step instead |

`$item` and `$loop_index` are ALWAYS bound inside the step — the runtime
builds the child scope as `{ ...scope, $item: item, $loop_index: i }`.
`${project.id}` / `${user.email}` are NEVER valid placeholders: the
placeholder resolver accepts only the kinds
`cred | connector | input | scope | item | state`, and the JSONata
surface binds the item as `$item` only.

Compact worked example — a request per item, then a transform per item
that reads the request's result for the same index:

```json
[
  {
    "id": "fetch_languages",
    "kind": "request",
    "for_each": "(sourceData) => sourceData.list_repos.data.repositories",
    "method": "GET",
    "connector_id": "<github_connector_id>",
    "path": "/repos/${item.full_name}/languages"
  },
  {
    "id": "shape_repo",
    "kind": "transform",
    "for_each": "(sourceData) => sourceData.list_repos.data.repositories",
    "language": "javascript",
    "expression": "return { name: input.scope.$item.name, index: input.scope.$loop_index, languages: input.scope.fetch_languages.data[input.scope.$loop_index].fetch_languages.data };"
  }
]
```

`fetch_languages` (request) addresses the item via `${item.full_name}`;
`shape_repo` (transform) iterates the same array, reads the current item
via `input.scope.$item`, the always-bound `input.scope.$loop_index`, and
the matching request result via
`input.scope.fetch_languages.data[input.scope.$loop_index].fetch_languages.data`.
A downstream transform reads `input.scope.shape_repo.data[i].shape_repo.data.name`.

### `for_each` output shape

`$scope.<step_id>.data` is an array of iteration objects, each keyed
by the step's own id with a full ScopeEnvelope inside. Path to a field:
`$scope.<step_id>.data.<step_id>.data.<field>`.

To project across iterations, use a JS transform
(`input.scope.<step_id>.data.map(iter => iter.<step_id>.data…)`).
Transforms are JavaScript — there is no JSONata transform form. If
fewer keys come out than went in, a `transform_dropped_fields` warning fires
(informational only — see "Repair signal" below).

Debugging — call `inspect_workflow` (multi-step) or
`inspect_execution_step` (single step from a prior run) to read the real
shape before authoring the next projection. Do not guess at paths.

Worked examples (DigitalOcean projects with their resources, HATEOAS `links.self` expansion) live in `workflow-authoring-loop-examples`.

### JSONata flavour rules (variable blocks, dynamic keys, concatenation)

These apply to the JSONata slots (`branch.when`,
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
  transforms and steps with `for_each`.**
- You referenced the current item by a bare name (`project.name`) — the
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

### Branches

`when` is JSONata: truthy runs `then_steps`, falsy runs optional
`else_steps`. Both list **step ids** of steps that sit flat in the top-level
`steps`. No `config` wrapper, no `cases` / `default`.

```json
{
  "id": "route",
  "kind": "branch",
  "when": "$scope.classify.data.tier = 'enterprise'",
  "then_steps": ["white_glove"],
  "else_steps": ["self_serve"]
}
```

Multi-way routing: chain branches by listing a second `branch` id in
`else_steps`.

### Parallel

`branches` holds chains of **step ids** that run concurrently; the steps sit
flat in the top-level `steps`. No `config` wrapper, no `join` field. Chains
read `$scope.<upstream_id>.data` from steps finished before the `parallel`.

```json
{
  "id": "fanout",
  "kind": "parallel",
  "branches": [["write_pg"], ["write_s3"]]
}
```

## Structure pitfalls

- **Writing a `loop` step.** The kind does not exist; the validator
  rejects it with the rewrite to use. Put
  `for_each: "(sourceData) => sourceData.<step>.data.<array>"` on the step
  that should repeat.

- **Step id collisions.** Step ids must be unique across the whole
  workflow. The validator rejects duplicates.
