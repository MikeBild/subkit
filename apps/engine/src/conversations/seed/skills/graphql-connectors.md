---
slug: graphql-connectors
scope: global
title: GraphQL Connectors
description: Driver specifics for the GraphQL connector — queries, mutations, variables, batching.
gates_tools: []
version: 2
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

- If `response.data` is non-null and `response.errors` is present, the
  envelope has both `data` (the partial payload) and `error` (the first
  error's message plus `details: { all_errors: [...] }`). The step is
  marked failed; `on_error` decides whether to abort or continue.
- If `response.data` is null, envelope `data` is null and `error` is set.

If partial data is acceptable, set `on_error: "continue"` directly on the
step so the run keeps going past the failure. Add `max_retries` /
`retry_backoff_ms` for transient infrastructure issues:

```json
{
  "id": "list_repos_lenient",
  "kind": "request",
  "connector_id": "<github_graphql_connector_id>",
  "graphql": {
    "query": "query { viewer { repositories(first: 10) { nodes { name } } } }"
  },
  "on_error": "continue",
  "max_retries": 2,
  "retry_backoff_ms": 500
}
```

## Auth

GraphQL connectors use the same auth modes as `http` — `bearer`, `header`,
`query`, `basic`, and `oauth2`. The driver posts to a single `base_url` (the
GraphQL endpoint), so `path` is ignored. Set auth once on the connector;
reference credentials only if you need them inside variables (e.g. an API key
as an input to the query).

Common GraphQL auth conventions, mapped to sk `auth_type`:

| Provider                       | `auth_type` | Header / config                                  |
|--------------------------------|-------------|--------------------------------------------------|
| GitHub GraphQL, Linear, Monday | `bearer`    | `Authorization: Bearer <PAT or OAuth token>`     |
| Hasura admin secret            | `header`    | `x-hasura-admin-secret: <secret>`                |
| AppSync API_KEY                | `header`    | `x-api-key: <key>`                               |
| AppSync Cognito User-Pool      | `header`    | `Authorization: <id_token>` (raw JWT, no prefix) |
| AppSync Lambda authorizer      | `header`    | `Authorization: <token>` (custom shape)          |
| Auth0 Management GraphQL       | `oauth2`    | client-credentials grant; refreshed inline       |
| Internal services              | `basic`     | base64-encoded `username:password`               |

### AppSync Cognito JWT — raw `Authorization` (no "Bearer ")

AppSync Cognito User-Pool auth expects the ID token in the `Authorization`
header **without** a scheme prefix:

```
Authorization: eyJraWQiOiJ…
```

Two ways to get this with sk:

1. **Static token (`auth_type=header`)** — best when you have a long-lived
   ID token or a Lambda authorizer with a custom format. Store it as a
   header credential:
   ```json
   { "mode": "header", "headers": { "Authorization": "eyJ…" } }
   ```

2. **Refreshable JWT (`auth_type=oauth2`)** — when the IdP rotates the
   token. Set `token_type: "none"` on the credential (or leave it empty);
   the driver emits the access token verbatim instead of `Bearer …`.

   Inline-refresh still runs — only the scheme prefix is suppressed.

For `oauth2`, the driver runs the inline-refresh path before every request —
a stale `access_token` is rotated automatically using the persisted
`refresh_token`. The applied auth method is observable on
`request_meta.connector.auth_method`: `"oauth2_refreshed"` if the token was
just rotated, `"oauth2_static"` if the cached token was still fresh.

AppSync IAM (SigV4) is **not** supported today — open an issue if you need
it. For now, stand up an API_KEY or Cognito user-pool path.

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
