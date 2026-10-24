---
slug: workflow-authoring-structures
scope: global
title: Workflow Loops, Fan-Out And Branches
description: Multi-step structures: bulk list over per-item loops, inline `for_each` fan-out, bounded traversal of nested data, the `loop` step with its addressing table, branches, parallel, and JSONata flavour rules.
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

## Multi-step structures

### Loops

Iterate over an array from a prior step. Each iteration exposes the
current item as `$item` (JSONata) / `${item.…}` (request strings),
plus `$loop_index` (zero-based). The item is NOT envelope-wrapped.
`item_var` is retired and rejected.

Loop `over` and transform edits are gated by recorded preview evidence; `workflow-authoring-repair` covers the gate and its one-round-trip recovery.

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

Worked examples (DigitalOcean projects with their resources, HATEOAS `links.self` expansion) live in `workflow-authoring-loop-examples`.

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

## Structure pitfalls

- **Using the `loop` kind for simple one-step fan-out.** Prefer `for_each`
  on the step (`for_each: "(sourceData) => sourceData.<step>.data.<array>"`).
  The `loop` kind is only needed when the iteration body requires multiple
  sequential sibling steps or nested aggregation.

- **Nested loop id collisions.** `loop.body[].id` values must be unique across
  the whole workflow, not just within the body. The validator rejects duplicates.
