---
slug: data-handling
scope: global
title: Data Handling Between Steps
description: The envelope, JSONata cheatsheet, data_selector vs transform vs outputTransform, and how to keep scope small.
gates_tools: []
version: 1
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
  "config": { "connector": "github", "method": "GET", "path": "/repos/org/repo/issues" },
  "data_selector": "$.{ 'id': id, 'title': title, 'labels': labels.name }"
}
```

After this step, `$scope.fetch_issues.data` is an array of small objects. The
original bloated response is gone from scope entirely.

## Transform step — reshape across steps

A `transform` step has its own envelope and is the right place for
multi-source reshaping:

```json
{
  "id": "report_rows",
  "kind": "transform",
  "config": {
    "expression": "$scope.orders.data.{ 'order_id': id, 'customer': $scope.customers.data[id = $$.customer_id].email, 'total': total }"
  }
}
```

Downstream steps read `$scope.report_rows.data`. The `transform` step has
`status_code: 200` if JSONata evaluated without error, `error` set otherwise.

## Workflow-level `outputTransform`

Runs once, at the very end, to shape the caller's view:

```json
{
  "outputTransform": "{ 'rows': $scope.report_rows.data, 'generated_at': $now(), 'tenant': ${input.tenant_id} }"
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
      "config": { "connector": "shop", "method": "GET", "path": "/orders?since=${input.since}" },
      "data_selector": "$.orders.{ 'id': id, 'email': customer.email, 'total': total_price, 'status': financial_status }"
    },
    {
      "id": "fetch_contacts",
      "kind": "request",
      "config": { "connector": "crm", "method": "GET", "path": "/contacts" },
      "data_selector": "$.results.{ 'email': email, 'lifecycle': lifecyclestage }"
    },
    {
      "id": "joined",
      "kind": "transform",
      "config": {
        "expression": "$scope.fetch_orders.data.{ 'order_id': id, 'total': total, 'lifecycle': $scope.fetch_contacts.data[email = $$.email].lifecycle ? $scope.fetch_contacts.data[email = $$.email].lifecycle : 'unknown' }"
      }
    },
    {
      "id": "totals_by_lifecycle",
      "kind": "transform",
      "config": {
        "expression": "$scope.joined.data{ lifecycle: $sum(total) }"
      }
    }
  ],
  "outputTransform": "{ 'report': $scope.totals_by_lifecycle.data, 'row_count': $count($scope.joined.data) }"
}
```

Walk-through:

1. `fetch_orders` and `fetch_contacts` each trim to 4 and 2 fields via `data_selector`. Scope stays small.
2. `joined` correlates by email with a null-safe default of `'unknown'`.
3. `totals_by_lifecycle` groups + sums in one JSONata expression.
4. `outputTransform` builds the public payload with a row count sibling.

## Loop iteration variables

A `loop` step exposes its current item as a **top-level scope key** named
after `item_var` (or `item` if `item_var` is omitted). Inside the loop body,
reference it WITHOUT the `$scope.` prefix and WITHOUT `.data` — the item is
not envelope-wrapped.

Correct:

```json
{ "id": "list_projects",     "kind": "request", "path": "/v2/projects" }
{ "id": "for_each_project",  "kind": "loop",
  "over": "$scope.list_projects.data.projects",
  "item_var": "project",
  "body": ["fetch_resources"] }
{ "id": "fetch_resources",   "kind": "request",
  "path": "/v2/projects/${project.id}/resources" }
```

`$loop_index` (zero-based) is also available inside the loop body.

Wrong — the validator (or the engine at run time) will reject each of these:

```
"/v2/projects/${scope.project.id}/resources"          # extra `scope.` prefix
"/v2/projects/$scope.for_each_project.data.id/..."   # loop step has no envelope
"/v2/projects/${project.data.id}/resources"           # item is not envelope-wrapped
"/v2/projects/${item.id}/resources"                   # only valid when item_var was omitted
```

The same rules apply in JSONata expressions (`$item_var.field`, no `$scope.`)
and in `data_selector` / `transform` configs inside loop bodies.

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
  re-evaluated per iteration inside a `loop` unless the placeholder references
  the loop's `item_var` binding (see "Loop iteration variables" above).

## See also

- `subkit-concepts.md` — envelope and placeholder tokens.
- `workflow-authoring.md` — when to use each reshaping location.
- `http-connectors.md` — pagination and the shape of concatenated responses.
