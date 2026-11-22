---
slug: github-graphql-basics
scope: connector
title: GitHub GraphQL API Basics
description: How to author workflows against the github-graphql connector — query structure, pagination, rate-limit costs.
activates_when: [{"kind":"connector_template","slug":"github-graphql"},{"kind":"intent_keyword","word":"github graphql"},{"kind":"intent_keyword","word":"github-graphql"},{"kind":"intent_keyword","word":"github v4"},{"kind":"intent_keyword","word":"graphql query"},{"kind":"intent_keyword","word":"pageInfo"},{"kind":"intent_keyword","word":"endCursor"}]
side_effects: read
idempotency: naturally
maturity: stable
tags: [connector, github, graphql]
version: 6
---

# GitHub GraphQL API Basics

The `github-graphql` connector targets `https://api.github.com/graphql`. A REST token can also authenticate GraphQL, but access still depends on its permissions. Private repository reads need repository access; private Projects also need `read:project` for read-only access. Check the token's actual scopes before authoring Project queries. Do not request the write-capable `project` scope merely to read a Project.

Prefer GraphQL over REST when a workflow reads nested data (repo → issues → comments → labels) that would otherwise require many REST roundtrips. Prefer REST for write operations — GitHub's GraphQL mutations are incomplete, especially for organisation-admin calls.

## Step shape

A request step with a `graphql` sub-object is always sent as POST. On a graphql connector the endpoint is its base_url and `path`/`method` are ignored. On an existing http connector with base_url `https://api.github.com`, keep the `graphql` block and set `"path": "/graphql"` (no `url`, no `body`): the step reuses that connector's credential and headers, keeps `cursor_pagination`, and is reviewed by its operation (a query is a read).

```json
{
  "id": "project_items",
  "kind": "request",
  "connector_id": "<github-http-connector-id>",
  "path": "/graphql",
  "graphql": {
    "operation": "query",
    "query": "query ProjectItems($login:String!,$number:Int!,$after:String){ user(login:$login){ projectV2(number:$number){ items(first:100,after:$after){ totalCount nodes { id } pageInfo { hasNextPage endCursor } } } } }",
    "variables": { "login": "octocat", "number": 1, "after": null },
    "cursor_pagination": { "connection_path": "user.projectV2.items", "cursor_variable": "after", "items_field": "nodes", "max_pages": 20, "max_items": 2000 }
  }
}
```

The same block on a graphql connector:

```json
{
  "id": "list_open_issues",
  "kind": "request",
  "connector_id": "<github-graphql-connector-id>",
  "graphql": {
    "operation": "query",
    "query": "query IssuesWithComments($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ issues(last:20,states:OPEN){ nodes { number title comments(last:5){ nodes { body } } labels(first:10){ nodes { name } } } } } }",
    "variables": { "owner": "subkit", "name": "subkit" }
  }
}
```

## Naming operations

Always name operations (`query MyOp { ... }` not bare `{ ... }`). `request_meta.operation_name` picks the name up, so the same workflow step is attributable in traces and metrics even when the query string itself changes.

## Pagination

GraphQL pagination uses `pageInfo.endCursor` + `first: 50`. Example:

```graphql
query($after: String) {
  repository(owner: "subkit", name: "subkit") {
    issues(first: 50, after: $after, states: OPEN) {
      nodes { number title }
      pageInfo { endCursor hasNextPage }
    }
  }
}
```

For sensitive workflows, keep pages inside one read-only GraphQL request step with `graphql.cursor_pagination`. Set `connection_path` to the path inside GraphQL `data`, such as `repository.issues`, `cursor_variable` to `after`, `items_field` to `nodes` or `edges`, and explicit `max_pages` and `max_items` limits. Request `pageInfo { endCursor hasNextPage }` and, when available, `totalCount`. The step returns the merged connection only after all pages pass completeness checks; limit exhaustion, repeated cursors, partial GraphQL errors, or a count mismatch fail without a partial snapshot. Ordinary workflows may also use a bounded loop. Never claim completeness from a first page with `hasNextPage: true`.

For `ProjectV2.items` with selected `fieldValues`, set `required_connection_paths: ["fieldValues"]` and request `fieldValues { totalCount nodes { ... } pageInfo { hasNextPage } }`. If its `hasNextPage` is true, the outer items cursor cannot finish it; query that item's field values separately before reporting a complete project snapshot.

For Projects, query `ProjectV2.items(first: ..., after: ...)` and read its `pageInfo` and `totalCount`. Probe the exact query with the authenticated connector; a working repository query does not prove Project access. GitHub's REST OpenAPI discovery is not required for a GraphQL query.

GitHub sometimes answers `ProjectV2.items` with an empty connection (`totalCount: 0`, no nodes, no `errors`, HTTP 200) for a project that has items; the REST project items list shows the same. Use `first: 100` so a project needs as few pages as possible. For a project known to have items, set `cursor_pagination.expected_items` to `{ "min": 1 }`, `reread_on_empty` to `2` and the step's `retry_backoff_ms` to about `1000`. Different item counts from two tokens are not proof of missing scopes; repeat the same query before concluding that access differs. Treat a project snapshot as complete only when its item count matches `totalCount` from an independent read of the same query.

Before saving, validate the exact query as a syntactically valid GraphQL document containing an operation, then probe that query against the authenticated API with bounded fields. An HTTP 200 or a shape/sample response proves only that the probed fields resolved; it does not prove that every page or nested connection was read. Verify the returned item counts and that pagination ends with `hasNextPage: false`. Treat sample and shape probes as schema evidence only, never as complete workflow-run evidence.

## Rate-limit budget

Cost, not request count, is the budget. `first`/`last` must be 1–100; a larger value fails with error type `EXCESSIVE_PAGINATION` and is not retried. Every response carries:

- `X-RateLimit-Cost` — how many points this query consumed
- `X-RateLimit-Remaining` — how many points remain in the hourly window
- `X-RateLimit-Reset` — unix timestamp when the window resets

A workflow that polls every minute with `cost=30` will exhaust the 5000/h budget in under three hours. Watch `request_meta.bytes_in` in a test run — oversized responses usually correlate with high cost.

An exhausted primary limit still answers HTTP 200 with an error of type `RATE_LIMITED` and `x-ratelimit-remaining: 0`; a secondary limit answers 200 or 403, sometimes with `retry-after`. The engine waits for `retry-after`, then for `x-ratelimit-reset`, otherwise at least one minute, doubling per attempt, and fails the step with `upstream_rate_limited` without further requests when that wait passes the step's `timeout_ms` (or one hour). Run the workflow again after the reset.

## Pitfalls

- Subscriptions are not supported by the subkit `graphql` driver. Use webhooks for push.
- Under-requested fields can break downstream steps silently — explicitly list every field the workflow consumes.
- Variables are stricter than REST query strings: type them in the query header (`$owner: String!`) or the request fails before the wire.
- A GraphQL query uses HTTP POST but is read-only only when the reviewed document contains no mutation. Keep the effect review and the caller's approval boundary intact.
- A `graphql` block runs on a graphql connector, or on an http connector with a fixed same-host `"path": "/graphql"` and no `url`. When the step's connector is an http connector (for example base_url `https://api.github.com`), keep the `graphql` block with its `cursor_pagination` and set `path` to `/graphql`; a separate graphql connector is not needed. A missing path, an absolute URL, `..`, a query string or a placeholder in the path is refused before anything is sent. Never convert the step to `POST /graphql` with a `body.query` on the http connector: that drops `cursor_pagination`, so only the first page is read, and a mutation or an unparseable or runtime-assembled document is reviewed as a write. The engine refuses that conversion.

## Sources

- https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects
- https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api
- https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
