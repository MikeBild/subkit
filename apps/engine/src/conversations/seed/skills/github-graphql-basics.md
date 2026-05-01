---
slug: github-graphql-basics
scope: connector
title: GitHub GraphQL API Basics
description: How to author workflows against the github-graphql connector — query structure, pagination, rate-limit costs.
gates_tools: []
version: 2
auto_load: false
trigger_keywords: [github graphql, github-graphql, github v4, graphql query, pageInfo, endCursor]
---

# GitHub GraphQL API Basics

The `github-graphql` connector targets the GitHub GraphQL v4 endpoint at `https://api.github.com/graphql`. It uses the same PAT or OAuth token as the REST connector (scopes `repo` + `read:org`), so operators don't need to re-issue credentials.

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

Drive the cursor with a `loop` step whose body reads `$prev.data.repository.issues.pageInfo.endCursor` as `$after` and exits when `hasNextPage` is `false`.

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
