---
slug: graphql-authoring-recipe
scope: global
title: GraphQL Authoring Recipe
description: Step-by-step recipe for GraphQL workflows — introspection-first schema check, filter discovery, Relay pagination, fan-out reduction, and partial-error handling.
activates_when: [{"kind":"connector_driver","driver":"graphql"}]
side_effects: read
idempotency: naturally
maturity: stable
tags: [driver, graphql, recipe]
version: 1
---

# GraphQL Authoring Recipe

Use this recipe in order. Each phase builds on the previous one.

## Phase 1 — Introspection first: schema and drift check

Before writing any query, verify the current schema:

1. Call `discover_connector_endpoints` with the **`connector_id`** of the
   GraphQL connector (not `template_id`). This runs `__schema` introspection
   and ingests the SDL as a searchable knowledge source.
2. Call `search_knowledge` for every type you will touch: connection types,
   filter input types, enum types — read their exact field names and values.
3. When a `400 Bad Request` returns "Cannot query field X on type Y", the
   schema has drifted since introspection was last run. Re-run
   `discover_connector_endpoints` to refresh the SDL, then `search_knowledge`
   again for the affected type. Do not guess field names from prior sessions
   or documentation snippets.

Skipping introspection is the single largest cause of GraphQL authoring
churn: the model guesses a wrong field name or enum value, the query 400s,
and the cycle repeats. One pass up front removes the loop.

## Phase 2 — Server-side filter discovery

Fetching a full list and filtering in a transform wastes bandwidth and
complexity budget. Most GraphQL schemas expose server-side filter arguments.

**How to identify filter support:**

Look in the introspected SDL for a root field that accepts a `filter` or
`where` input argument: `items(filter: ItemFilter, first: Int, after: String)`.
Run `search_knowledge "ItemFilter"` to read its exact field shapes.

**Common filter input shapes:**

| Input pattern | Operator fields | Example value |
|---|---|---|
| `StringFilter` | `eq`, `neq`, `contains`, `startsWith`, `in` | `{ status: { eq: "OPEN" } }` |
| `DateTimeFilter` | `eq`, `gt`, `gte`, `lt`, `lte`, `between` | `{ createdAt: { gte: "2026-01-01T00:00:00Z" } }` |
| `NumberFilter` | `eq`, `gt`, `gte`, `lt`, `lte` | `{ priority: { gte: 3 } }` |
| Direct enum | no wrapper — raw enum value | `{ state: ACTIVE }` |

If there is no `filter` argument on the root field, it is a list-query-only
endpoint: fetch all records and narrow the result in a JS transform step.

## Phase 3 — Relay cursor pagination

Most GraphQL APIs use the Relay Connection pattern. Rows live at
`edges[].node`, not at the top-level field:

```graphql
query ListItems($first: Int!, $after: String) {
  items(first: $first, after: $after) {
    edges {
      node { id name createdAt }
    }
    pageInfo {
      hasNextPage
      endCursor
    }
    totalCount
  }
}
```

Step variables pattern for the first page (omit `after`):

```json
{
  "query": "query ListItems($first: Int!, $after: String) { items(first: $first, after: $after) { edges { node { id name } } pageInfo { hasNextPage endCursor } } }",
  "variables": { "first": 50 }
}
```

For a standard Relay connection, `graphql.cursor_pagination` can collect pages inside one request step. Set `connection_path` relative to GraphQL `data`, `cursor_variable` to `after`, `items_field` to `nodes` or `edges`, and explicit `max_pages` and `max_items`. It fails without partial output when pages, cursors, counts, or limits cannot establish completeness. This works for sensitive execution without persisting intermediate pages. A mutation cannot use it.

For a workflow loop instead, pass the cursor from the previous step:

```json
{ "first": 50, "after": "${scope.<prev_step_id>.data.items.pageInfo.endCursor}" }
```

Stop when `pageInfo.hasNextPage` is `false`.

**`pageInfo` field names vary — always check introspection:**

| Field | Common alternative | Meaning |
|---|---|---|
| `hasNextPage` | `hasNext` | More pages exist |
| `endCursor` | `nextToken` | Opaque token for the next page |

A `nextToken` pattern (flat cursor returned at the connection root, no
`pageInfo` wrapper) signals a non-Relay pagination style. Read that field
directly from `$scope.<step>.data.<connection>.nextToken`.

## Phase 4 — Fan-out reduction on nested resolvers

GraphQL servers execute a separate resolver for each nested selection. Deep
selections in a single query can:

- Exceed the server's per-query complexity budget, returning `400 Bad Request`
  with a "Query complexity is too high" message.
- Trigger per-field throttling: the server rate-limits individual resolver
  calls even though the top-level query returns 200.
- Increase response latency proportionally to nesting depth.

**Reduction strategies:**

1. **Select only fields the next step consumes.** If the downstream step
   only uses `id` and `name`, do not also select `assignee { id name }`,
   `labels(first: 10) { nodes { name } }`, and `comments(last: 5) { nodes
   { body } }` in the same query. Split into a second step if those fields
   are only needed on a later branch.
2. **Check `totalCount` on the first page** before committing to a
   pagination loop. If `totalCount` is small, a single `first: 100` page
   avoids a loop entirely.
3. **Search for complexity budget documentation** with
   `search_knowledge "complexityLimit"` or `search_knowledge "maxDepth"`.
4. **Watch `request_meta.complexity_cost`** in dry-run output — if the
   server includes a cost field, reduce selected fields until the cost stays
   within budget.

## Phase 5 — Partial errors and retry

**`error_policy` knob:**

- `error_policy: "none"` (default) — any non-empty `errors` array fails the
  step. Read the error from `$scope.<step>.error.details.all_errors`.
- `error_policy: "all"` — accepts partial results. The step succeeds when
  `data` is present; `request_meta.partial` is `true` and
  `request_meta.graphql_errors` holds the error list. If `data` is null,
  the step still fails.

**Retry for throttle-prone queries:**

```json
{
  "id": "fetch_items",
  "kind": "request",
  "connector_id": "<gql_connector_id>",
  "graphql": {
    "query": "query ListItems($first: Int!) { items(first: $first) { edges { node { id } } } }",
    "variables": { "first": 50 }
  },
  "error_policy": "all",
  "max_retries": 4,
  "retry_backoff_ms": 300
}
```

The driver retries automatically on HTTP 429, 5xx, and structured throttling
codes in `extensions.code` / `extensions.errorType` / `extensions.classification`
(classes THROTTL, RATE_LIMIT, TOO_MANY_REQUESTS, TIMEOUT, UNAVAILABLE,
TRY_AGAIN, INTERNAL). Throttle-prone nested queries benefit from larger
`retry_backoff_ms` values (500–2000 ms) and smaller page sizes.

## See also

- `graphql-connectors.md` — full driver reference (step shape, variables,
  auth, error_policy, retry).
- `data-handling.md` — reshaping nested GraphQL responses.
- `error-recovery.md` — recovery playbook when a step fails mid-authoring.
