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
version: 5
---

# GitHub GraphQL API Basics

The `github-graphql` connector targets `https://api.github.com/graphql`. A REST token can also authenticate GraphQL, but access still depends on its permissions. Private repository reads need repository access; private Projects also need `read:project` for read-only access. Check the token's actual scopes before authoring Project queries. Do not request the write-capable `project` scope merely to read a Project.

Prefer GraphQL over REST when a workflow reads nested data (repo → issues → comments → labels) that would otherwise require many REST roundtrips. Prefer REST for write operations — GitHub's GraphQL mutations are incomplete, especially for organisation-admin calls.

## Step shape

A request step against a GraphQL connector uses the `graphql` sub-object rather than `path`/`method`:

```json
{
  "id": "list_open_issues",
  "kind": "request",
  "connector_id": "<github-graphql-connector-id>",
  "graphql": {
    "operation": "query",
    "query": "query IssuesWithComments($owner:String!,$name:String!){ repository(owner:$owner,name:$name){ issues(last:20,states:OPEN){ nodes { number title comments(last:5){ nodes { body } } labels(first:10){ nodes { name } } } } } }",
    "variables": { "owner": "sk", "name": "sk" }
  }
}
```

## Naming operations

Always name operations (`query MyOp { ... }` not bare `{ ... }`). `request_meta.operation_name` picks the name up, so the same workflow step is attributable in traces and metrics even when the query string itself changes.

## Pagination

GraphQL pagination uses `pageInfo.endCursor` + `first: 50`. Example:

```graphql
query($after: String) {
  repository(owner: "sk", name: "sk") {
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

Before saving, validate the exact query as a syntactically valid GraphQL document containing an operation, then probe that query against the authenticated API with bounded fields. An HTTP 200 or a shape/sample response proves only that the probed fields resolved; it does not prove that every page or nested connection was read. Verify the returned item counts and that pagination ends with `hasNextPage: false`. Treat sample and shape probes as schema evidence only, never as complete workflow-run evidence.

## Rate-limit budget

Cost, not request count, is the budget. Every response carries:

- `X-RateLimit-Cost` — how many points this query consumed
- `X-RateLimit-Remaining` — how many points remain in the hourly window
- `X-RateLimit-Reset` — unix timestamp when the window resets

A workflow that polls every minute with `cost=30` will exhaust the 5000/h budget in under three hours. Watch `request_meta.bytes_in` in a test run — oversized responses usually correlate with high cost.

## Pitfalls

- Subscriptions are not supported by the sk `graphql` driver. Use webhooks for push.
- Under-requested fields can break downstream steps silently — explicitly list every field the workflow consumes.
- Variables are stricter than REST query strings: type them in the query header (`$owner: String!`) or the request fails before the wire.
- A GraphQL query uses HTTP POST but is read-only only when the reviewed document contains no mutation. Keep the effect review and the caller's approval boundary intact.
- A `graphql` block needs a connector whose driver is `graphql`. When the step's connector is an http connector (for example base_url `https://api.github.com`), point `connector_id` at a graphql connector whose base_url is `https://api.github.com/graphql` and keep the `graphql` block with its `cursor_pagination`, or rewrite the read against the REST endpoint. Never convert the step to `POST /graphql` with a `body.query` on the http connector: that drops `cursor_pagination`, so only the first page is read, and the request is reviewed as a write. The engine refuses that conversion; ask the user which connector to use when neither exists.

## Sources

- https://docs.github.com/en/issues/planning-and-tracking-with-projects/automating-your-project/using-the-api-to-manage-projects
- https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api
- https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api
