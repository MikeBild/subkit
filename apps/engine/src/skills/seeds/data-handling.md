---
slug: data-handling
scope: global
title: Data Handling Between Steps
description: The envelope, JSONata cheatsheet, data_selector vs transform vs the workflow-level output transform, and how to keep scope small.
activates_when: [{"kind":"tool_arg","tool":"edit_workflow_patch","path":"patches[*].value.kind","equals":"transform"}]
side_effects: read
idempotency: none
maturity: stable
tags: [authoring, transforms, jsonata]
version: 8
---

# Data Handling Between Steps

Every workflow is a data pipeline. Ninety percent of authoring errors are
shape mismatches between steps — a producer emits `{ results: [...] }` and the
consumer reads `.items`. This skill is the deep reference for getting data
shaping right.

## The envelope rule

**Always** `$scope.<step_id>.data`. Never `$scope.<step_id>`.

Say it out loud. The engine wraps every step's output in the envelope:

```json
{
  "data": <anything>,
  "status_code": 200,
  "headers": { ... },
  "error": null,
  "duration_ms": 42
}
```

Writing `$scope.list_orders.results` accesses `.results` on the envelope
itself. That field doesn't exist. JSONata returns `undefined`, which silently
propagates — your next `transform` gets `null`, your final output is empty,
and nothing logs an error. This is the single most time-consuming authoring
bug in subkit.

The three envelope fields you actually use downstream:

| Access | When to reach for it |
|---|---|
| `$scope.<id>.data` | The payload. You want this 95% of the time. |
| `$scope.<id>.status_code` | Branching on HTTP status, logging, observability |
| `$scope.<id>.headers."x-request-id"` | Correlation with vendor logs |

`$scope.<id>.error` is readable but only set when `onError.mode` is not `fail`
(on `fail`, the run has already aborted).

## JSONata cheatsheet

`transform` steps are JavaScript-ONLY (see "Transform step" below) —
JSONata is NOT a transform language. It remains the canonical language
for `data_selector`, `branch.when`, the JSONata
`output_transform`, and `${scope.x.data}` string interpolation, so this
cheatsheet still matters for those slots.

### Selection

```
$scope.fetch.data.results              -> array
$scope.fetch.data.results[0]           -> first item (or the only item if single)
$scope.fetch.data.results[0].id        -> first item's id
$scope.fetch.data.results.id           -> array of ids (auto-mapping)
```

### Filtering

```
$scope.fetch.data.results[status = 'open']            -> only open
$scope.fetch.data.results[amount > 100]               -> over-threshold
$scope.fetch.data.results[$not(archived)]             -> not archived
$scope.fetch.data.results[$contains(tags, 'urgent')]  -> tagged urgent
```

### Projection / reshaping

```
$scope.users.data.{                    -> reshape each user
  'id': id,
  'name': first_name & ' ' & last_name,
  'primary_email': emails[primary = true].address
}
```

### Aggregation

```
$sum($scope.orders.data.total)         -> total revenue
$count($scope.orders.data)             -> row count
$max($scope.orders.data.total)         -> largest order
$average($scope.orders.data.total)     -> mean
```

### Grouping

```
$scope.orders.data{ customer_id: $sum(total) }
```

Produces `{ "cust_a": 320.5, "cust_b": 180.0 }`.

### Joins

```
$scope.orders.data.{
  'order_id': id,
  'total': total,
  'customer_email': $scope.customers.data[id = $$.customer_id].email
}
```

`$$` refers to the outer context (the current order) so you can correlate
across two upstream steps.

### Null-safe defaults

```
$scope.fetch.data.items ? $scope.fetch.data.items : []
$exists($scope.fetch.data.cursor) ? $scope.fetch.data.cursor : null
```

### Sorting / order-by

JSONata's sort operator is `^( … )`. Prefix the key with `>` for descending,
`<` for ascending (the default).

```
$scope.issues.data^(>created)                  -> newest first
$scope.issues.data^(<priority, >created)       -> low-priority first, newest within ties
$scope.tasks.data^(>fields.priority.order)     -> nested key
```

For conditional ordering use the function form `$sort($, fn)`:

```
$sort($scope.issues.data, function($a, $b){ $a.score < $b.score })
```

**Slicing AFTER a sort:** wrap the sort in parens, then slice. Without
parens the sort applies inside the slice — almost always wrong.

```
($scope.issues.data^(>created))[[0..9]]        -> top 10 newest
```

### Regex / pattern matching

JSONata uses regex **literals** (`/pattern/`) the same way JavaScript does.
The two functions you reach for most:

```
$contains(s, 'SiD')                            -> true if 'SiD' is a substring
$contains(s, /SiD_FW v[0-9]+\.[0-9]+/)         -> true if the regex matches
$match(s, /v([0-9]+)\.([0-9]+)/).groups[0]     -> first capture group, e.g. '9'
$match(s, /v([0-9]+)/)                         -> { match, start, end, groups } or undefined
```

Filter rows whose `summary` looks like a `SiD_FW vX.Y` version:

```
$scope.issues.data[$contains(summary, /SiD_FW v[0-9]/)]
```

**Syntax that does NOT exist in JSONata:**

- `summary =~ /pattern/` — `=~` is a Perl/Ruby operator. Use
  `$contains(summary, /pattern/)`.
- `$index(s, p)`, `s.indexOf(p)` — no method calls; use `$contains`.

### Object-constructor null thinning (the optional-field trap)

When you build a row with `{ ... }` and reference a path that does **not
exist** on a particular item, JSONata collapses that whole row to `null`.
The result is a list with `null` interspersed between real rows — looks
like every other row is missing.

```jsonata
$scope.issues.data.issues.{
  "key": key,
  "assignee": fields.assignee.displayName          -- null if assignee absent → row becomes null
}
```

Fix: guard the optional path with `$exists(…)` or a ternary default.

```jsonata
$scope.issues.data.issues.{
  "key": key,
  "assignee": $exists(fields.assignee) ? fields.assignee.displayName : null
}
```

The same trap fires on nested optional chains — `fields.parent.key` will
thin the row when the issue has no `parent`. Guard the *first* optional
hop in the chain, not the leaf.

### Array slicing & limiting (first N)

JSONata indexes arrays with a **predicate in `[ ]`**. To take a fixed slice
you put a **range inside a second pair of brackets** — `[[ start..end ]]`.
The range bounds are zero-based and inclusive.

```
$scope.fetch.data.items[0]            -> first item
$scope.fetch.data.items[-1]           -> last item
$scope.fetch.data.items[[0..4]]       -> first 5 items (indices 0,1,2,3,4)
$scope.fetch.data.items[[0..2]]       -> first 3 items
$count($scope.fetch.data.items)       -> how many items
```

Limit **after a filter** — filter first, wrap, then slice:

```
($scope.fetch.data.chargers[isConnected = true])[[0..4]]   -> first 5 connected
```

Project then slice the same way:

```
($scope.users.data.{ 'id': id, 'email': email })[[0..9]]   -> first 10 reshaped
```

**Syntax that does NOT exist in JSONata — these are parse errors:**

- `items[0..4]` — a single-bracket range. Wrong. Use `items[[0..4]]`.
- `items[$i < 5]` — there is no implicit `$i` index variable. Wrong.
  Bind the position explicitly with `#`: `items#$i[$i < 5]` selects the
  first 5, or just use `items[[0..4]]`.
- `$slice(...)`, `items.slice(0,5)` — no such function/method.

When in doubt about a real shape, call `dry_run_transform` to test the
expression against the actual scope before committing.

## `data_selector` — trim at the step

`data_selector` runs **after** the step produces its envelope, and replaces
`.data` with the selector's result. Downstream steps see only the trimmed form.

Use it to:

- Drop heavy fields (full HTML bodies, base64 attachments) you'll never use.
- Narrow an HTTP list response to just the ids you need.
- Pre-join a single lookup result into a flat object.

Example — HTTP response is huge, we only need three fields:

```json
{
  "id": "fetch_issues",
  "kind": "request",
  "method": "GET",
  "connector_id": "<github_connector_id>",
  "path": "/repos/org/repo/issues",
  "data_selector": "$.{ 'id': id, 'title': title, 'labels': labels.name }"
}
```

After this step, `$scope.fetch_issues.data` is an array of small objects. The
original bloated response is gone from scope entirely.

## Transform step — reshape across steps

A `transform` step has its own envelope and is the right place for
multi-source reshaping. **Transforms are JavaScript-ONLY**
(`language: "javascript"`). JSONata is NOT a transform language —
`language: "jsonata"` on a `transform` step is rejected by the schema.
The authored code is a FUNCTION BODY with exactly ONE global, `input`,
and an explicit `return`:

- `input.scope.<step_id>.data` — each upstream step's output (every step
  output is enveloped; always read through `.data`).
- `input.input` — the workflow input.

```json
{
  "id": "report_rows",
  "kind": "transform",
  "language": "javascript",
  "expression": "return input.scope.orders.data.map(o => { const c = input.scope.customers.data.find(c => c.id === o.customer_id); return { order_id: o.id, customer: c ? c.email : 'unknown', total: o.total }; });"
}
```

Downstream steps read `$scope.report_rows.data`. The `transform` step has
`status_code: 200` if the expression evaluated without error, `error` set
otherwise — a wrong path in JS throws a real `TypeError` with the
runtime's own message instead of silently returning `undefined`.

## Workflow-level output transform

Runs once, at the very end, to shape the caller's view. Two forms — pick
exactly one (the schema rejects setting both):

- **`output_transform_function`** — JS function body, preferred for new
  workflows. Its single `input` IS the workflow's final value — the last
  step's `.data`, exactly what the caller would receive without a transform.
  There is NO `input.scope` and NO `input.input` here: reshape everything the
  output needs in the last step, then project it with an explicit `return`.
- **`output_transform`** — JSONata, legacy/compat. The root value is the same
  final value; `$scope.<step_id>.data` and `$input` are additionally bound.

```json
{
  "output_transform_function": "return { rows: input, row_count: input.length };"
}
```

Hides internal step ids from the caller. Makes the workflow's public contract
explicit. If a future refactor renames `report_rows` to `final`, the caller is
unaffected.

## Schema vs sample

Two declarations, two purposes:

- **`input_schema`** — JSON Schema, enforced at runtime. Use for production
  contracts.
- **`input_schema_sample`** — a literal example payload, used by `dry-run-step`
  and the LLM context builder so that downstream steps can be dry-run without a
  real input. Never enforced.

Both should exist in finished drafts. The sample lets reviewers see the
expected shape without running the workflow; the schema blocks malformed
input at the gate.

## A complete reshaping example

```json
{
  "steps": [
    {
      "id": "fetch_orders",
      "kind": "request",
      "method": "GET",
      "connector_id": "<shop_connector_id>",
      "path": "/orders?since=${input.since}",
      "data_selector": "$.orders.{ 'id': id, 'email': customer.email, 'total': total_price, 'status': financial_status }"
    },
    {
      "id": "fetch_contacts",
      "kind": "request",
      "method": "GET",
      "connector_id": "<crm_connector_id>",
      "path": "/contacts",
      "data_selector": "$.results.{ 'email': email, 'lifecycle': lifecyclestage }"
    },
    {
      "id": "joined",
      "kind": "transform",
      "language": "javascript",
      "expression": "return input.scope.fetch_orders.data.map((o) => { const c = input.scope.fetch_contacts.data.find((x) => x.email === o.email); return { order_id: o.id, total: o.total, lifecycle: c && c.lifecycle ? c.lifecycle : 'unknown' }; });"
    },
    {
      "id": "totals_by_lifecycle",
      "kind": "transform",
      "language": "javascript",
      "expression": "return input.scope.joined.data.reduce((acc, r) => { acc[r.lifecycle] = (acc[r.lifecycle] || 0) + r.total; return acc; }, {});"
    }
  ],
  "output_transform": "{ 'report': $scope.totals_by_lifecycle.data, 'row_count': $count($scope.joined.data) }"
}
```

Walk-through:

1. `fetch_orders` and `fetch_contacts` each trim to 4 and 2 fields via `data_selector`. Scope stays small.
2. `joined` correlates by email with a null-safe default of `'unknown'`.
3. `totals_by_lifecycle` groups + sums in a JS `reduce`.
4. `output_transform` builds the public payload with a row count sibling.

## `for_each` — inline per-step iteration (JS)

A step iterates by declaring `for_each` (a JS arrow-function string).
The selector receives `sourceData` (the full scope) and returns an
array; the step executes once per item. There is no `loop` step kind.

```json
[
  { "id": "list_projects", "kind": "request", "path": "/v2/projects" },
  {
    "id": "fetch_resources",
    "kind": "request",
    "connector_id": "<connector_id>",
    "path": "/v2/projects/${item.id}/resources",
    "for_each": "(sourceData) => sourceData.list_projects.data.projects"
  }
]
```

`for_each` bindings inside the step:

| You need | In `path`/`url`/`headers`/`query`/`body` strings | In `data_selector` (JSONata) |
|---|---|---|
| Current item field | `${item.<field>}` | `$item.<field>` |
| Iteration index (zero-based) | not available inline — derive in a prior transform | `$loop_index` |

The step output is an array: `$scope.fetch_resources.data` is an array
of iteration objects, each keyed by the step's own id with its envelope
inside. To project across iterations in a downstream
JS transform:

```json
{
  "id": "shape_output",
  "kind": "transform",
  "language": "javascript",
  "expression": "return input.scope.fetch_resources.data.map(iter => ({ id: iter.fetch_resources.data.id, name: iter.fetch_resources.data.name }));"
}
```

## Iteration variables — `$item` only

A step with `for_each` exposes its current item as **`$item`** in JSONata
expressions and **`${item.…}`** in request placeholder strings. A bare
item name (`project.name`) is rejected with a
`did_you_mean: "$item.name"` rewrite. The item is NOT envelope-wrapped —
no `$scope.` prefix, no `.data`.

`$loop_index` (zero-based) is also available inside the step.

Wrong — the validator (or the engine at run time) will reject each of these:

```
"/v2/projects/${scope.item.id}/resources"             # extra `scope.` prefix
"/v2/projects/${item.data.id}/resources"              # item is not envelope-wrapped
"/v2/projects/${project.id}/resources"                # bare item names are rejected — `item` is the only item placeholder kind
```

In JSONata surfaces on the step (`data_selector`, `branch.when`)
the only form is `$item.field` — no `$scope.` prefix,
no `.data`. Results of earlier steps are read via
`$scope.<step_id>.data.<field>` (JSONata) /
`input.scope.<step_id>.data.<field>` (JS transforms) /
`${scope.<step_id>.data.<field>}` (request strings).

## Common pitfalls

- **`$scope.foo.bar` without `.data`.** The envelope has no `bar`. Use `$scope.foo.data.bar`.
- **`data_selector` dropping fields you need.** If a later step reads a field
  you projected away, the access silently returns `undefined`. Always re-check
  `data_selector`s when adding new downstream consumers.
- **Using `transform` where `data_selector` suffices.** A full step adds scope
  pressure and an extra envelope. If you're only trimming one step's output,
  use `data_selector`.
- **Building huge intermediate arrays.** JSONata materializes. Pre-filter with
  `[...]` before projecting with `{...}` so you're not reshaping thousands of
  rows you'll throw away.
- **Assuming consistent casing across vendors.** One API returns `email`,
  another `emailAddress`. Normalize in `data_selector` at each step's boundary.
- **Forgetting `${...}` resolves once at step-start.** Placeholders are not
  re-evaluated per `for_each` iteration unless the placeholder references
  the current item via `${item.…}` (see "Iteration variables" above).
- **Inventing JSONata array syntax.** No single-bracket range (`items[0..4]`),
  no implicit index variable (`items[$i < 5]`), no `.slice()`. To take the
  first N use the double-bracket range `items[[0..N-1]]` — see "Array slicing
  & limiting" above.
- **Guessing nested paths instead of reading the preview.** After a
  `dry_run_workflow`, the authoring context lists the **real**
  `$scope.<step>.data.<path>` candidates for every previewed step. Copy one of
  those verbatim. If none is recorded yet, run a dry-run first or call
  `suggest_jsonata_paths` — never guess `.data.<field>` from documentation.

## See also

- `subkit-concepts.md` — envelope and placeholder tokens.
- `workflow-authoring-transforms.md` — when to use each reshaping location.
- `http-connectors.md` — pagination and the shape of concatenated responses.
