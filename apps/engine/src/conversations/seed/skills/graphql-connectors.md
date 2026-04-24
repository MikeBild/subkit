---
slug: graphql-connectors
scope: global
title: GraphQL Connectors
description: Driver specifics for the GraphQL connector — queries, mutations, variables, batching.
gates_tools: []
version: 1
---

# GraphQL Connectors

The `graphql` driver posts to a single GraphQL endpoint and returns the
raw GraphQL JSON body in the envelope's `data`. What the server sends as
`{ "data": { "foo": 42 }, "errors": [...] }` comes out as
`$scope.<step_id>.data = { "data": { "foo": 42 }, "errors": [...] }`.
That means downstream transforms typically read
`$scope.<step_id>.data.data.<field>`.

## Step shape

```json
{
  "id": "list_repos",
  "kind": "request",
  "connector_id": "00000000-0000-0000-0000-000000000001",
  "graphql": {
    "query": "query ListRepos($owner: String!, $first: Int!) { user(login: $owner) { repositories(first: $first) { nodes { name stargazerCount } } } }",
    "variables": { "owner": "${input.owner}", "first": 20 }
  }
}
```

For GraphQL request steps, `connector_id`, `method`, `path`, `query`, `headers`,
and `graphql` live at the top level of the step. Do not wrap them in a legacy
`config` object.

Three keys under `graphql`:

- **`query`** — the raw GraphQL document (query, mutation, or subscription).
- **`variables`** — a plain object. Placeholders are resolved before dispatch.
- **`operation`** — optional transport mode: `"query"`, `"mutation"`, or
  `"subscription"`. Omit it for reads; set `"mutation"` explicitly for writes.

The engine does **not** expose GraphQL `operationName` yet. Keep one query or
mutation per step instead of packing multiple named operations into a single
document.

## Variable placeholders

**Crucial distinction**: variables go through placeholder resolution **but not
through GraphQL string interpolation**. The driver resolves `${input.*}` and
`${scope.*}` in `variables`, then passes the resulting plain object to the
GraphQL endpoint as the standard `variables` field. Never interpolate into the
`query` string itself:

Correct:

```json
{
  "query": "query ($id: ID!) { deal(id: $id) { amount stage } }",
  "variables": { "id": "${input.deal_id}" }
}
```

Wrong (breaks server-side validation, exposes injection risk):

```json
{
  "query": "query { deal(id: \"${input.deal_id}\") { amount stage } }"
}
```

## Query vs mutation

Same step shape. The difference is semantic:

- **Query** — read. Safe to retry. Idempotent by contract.
- **Mutation** — write. Retries must be guarded by an `idempotencyKey`
  argument (most schemas support it) or by the server.

Example mutation:

```json
{
  "id": "move_deal",
  "kind": "request",
  "connector_id": "00000000-0000-0000-0000-000000000002",
  "graphql": {
    "operation": "mutation",
    "query": "mutation MoveDeal($id: ID!, $stage: String!, $key: String!) { updateDeal(id: $id, input: { stage: $stage }, idempotencyKey: $key) { id stage } }",
    "variables": {
      "id": "${input.deal_id}",
      "stage": "${input.target_stage}",
      "key": "${input.run_id}"
    }
  },
  "max_retries": 2,
  "retry_backoff_ms": 500
}
```

## Batching vs single queries

GraphQL's natural batching is putting multiple root fields in one query:

```json
{
  "id": "dashboard",
  "kind": "request",
  "connector_id": "00000000-0000-0000-0000-000000000003",
  "graphql": {
    "query": "query { orders(status: OPEN) { id total } customers(active: true) { id email } revenue(since: \"2026-01-01\") { total } }"
  }
}
```

Envelope `data` is the raw GraphQL body, so the payload sits under `.data`:
`$scope.dashboard.data.data.orders`, `$scope.dashboard.data.data.customers`, and so on.

This is almost always better than three separate steps hitting the same
endpoint — fewer round-trips, lower scope pressure, one auth flow. Use separate
steps only when:

- The queries have different auth (rare for GraphQL).
- One depends on the result of another.
- You want independent `onError` handling per query.

## Response errors

GraphQL servers return HTTP 200 with an `errors` array on partial failures.
The driver lifts that into the envelope:

- If `response.data` is non-null and `response.errors` is present, envelope
  has both `data` (the partial payload) and `error` (the first error's message
  plus `details: { all_errors: [...] }`). `onError` triggers.
- If `response.data` is null, envelope `data` is null, `error` is set.

Handle with `onError.mode: "fallback"` if partial data is acceptable:

```json
{
  "onError": {
    "mode": "fallback",
    "fallback_value": { "nodes": [] }
  }
}
```

## Auth

GraphQL connectors typically use `bearer` or `header` auth just like `http`.
The driver posts to a single `base_url` (the GraphQL endpoint), so `path` is
ignored. Set auth once on the connector; reference credentials only if you
need them inside variables (e.g. an API key as an input to the query).

## Common pitfalls

- **Interpolating into `query`.** Breaks syntax, breaks cache hits, and opens
  injection. Variables always.
- **Treating `status_code: 200` as success.** GraphQL errors ride on 200. Check
  `$scope.<step>.data.errors` before trusting `$scope.<step>.data.data`.
- **Sending multiple named operations.** The current step contract has no
  `operationName` field. Keep one query or mutation per step.
- **Retrying mutations without idempotency keys.** You'll create duplicates.
  Either guard with a server-side idempotency key or leave retries off for
  mutations.
- **Selecting fields the schema doesn't expose.** Results in `400 Bad Request`
  with a schema validation error. Use `probe_connector` with an introspection
  query first.

## See also

- `http-connectors.md` — if your GraphQL server also exposes REST fallbacks.
- `data-handling.md` — reshaping GraphQL's nested responses with JSONata.
- `error-recovery.md` — partial data + errors recovery pattern.
