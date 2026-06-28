---
slug: http-connectors
scope: global
title: HTTP Connectors
description: Driver specifics for the HTTP connector — methods, auth, pagination, retries.
activates_when: [{"kind":"tool","tool":"probe_connector"},{"kind":"tool_arg","tool":"propose_step","path":"step.kind","equals":"request"},{"kind":"connector_driver","driver":"http"}]
side_effects: read
idempotency: naturally
maturity: stable
tags: [driver, http, rest]
version: 4
---

# HTTP Connectors

The `http` driver is the most commonly used connector in sk. It speaks
REST/JSON over HTTPS, handles auth, retries, and pagination, and returns the
standard envelope.

## Placeholder grammar — the only forms the runtime substitutes

```
${cred.<slug>.<field>}                  ${connector.<slug>.base_url}
${connector.<slug>.config.<pointer>}    ${input.<pointer>}
${scope.<step_id>.<pointer>}            ${item.<pointer>}
```

Anything else ships **verbatim** into the URL, body, header, or query
value. Specifically:

- `{{ ... }}` — Mustache. Never substituted. The URL gets percent-
  encoded as `%7B%7B...%7D%7D` and the upstream API returns 404.
- `${user.X}` / `${project.X}` / `${data.X}` — unknown kinds. Rejected
  by `build_workflow` / `dry_run_workflow` with code
  `workflow_unsupported_placeholder`.
- `${$loop.X}` / `${$item.X}` — JSONata bindings, not placeholders.
  Inside an HTTP string field write `${item.X}`.

`base_url` is **already** baked into the connector. Write paths as
`/projects` (not `/v2/projects` if the connector's base_url is
`https://api.digitalocean.com/v2`). When in doubt, inspect the connector
with `find_connector` / `inspect_connector` and read `base_url` +
`example_paths` before writing the request step.

## Step shape

```json
{
  "id": "list_contacts",
  "kind": "request",
  "method": "GET",
  "connector_id": "<hubspot_connector_id>",
  "path": "/crm/v3/objects/contacts",
  "query": { "limit": 100 },
  "headers": { "accept": "application/json" },
  "body": null
}
```

The driver resolves `connector.base_url` + `path`, merges `query`, sets
auth headers from the connector's auth config, then dispatches. The envelope's
`status_code` is the raw HTTP status.

## Method patterns

### GET with query

```json
{
  "id": "search_issues",
  "kind": "request",
  "method": "GET",
  "connector_id": "<github_connector_id>",
  "path": "/search/issues",
  "query": { "q": "repo:${input.repo} is:open", "per_page": 50 }
}
```

### POST with JSON

```json
{
  "id": "create_task",
  "kind": "request",
  "method": "POST",
  "connector_id": "<asana_connector_id>",
  "path": "/api/1.0/tasks",
  "headers": { "content-type": "application/json" },
  "body": {
    "data": {
      "name": "${input.subject}",
      "notes": "${input.body}",
      "assignee": "${scope.lookup_user.data.gid}"
    }
  }
}
```

### PATCH with a conditional field

```json
{
  "id": "update_deal",
  "kind": "request",
  "method": "PATCH",
  "connector_id": "<hubspot_connector_id>",
  "path": "/crm/v3/objects/deals/${scope.find_deal.data.id}",
  "body": { "properties": { "dealstage": "${input.target_stage}" } }
}
```

### DELETE

```json
{
  "id": "delete_comment",
  "kind": "request",
  "method": "DELETE",
  "connector_id": "<github_connector_id>",
  "path": "/repos/${input.owner}/${input.repo}/issues/comments/${scope.find_comment.data.id}"
}
```

### Form-encoded body

For `application/x-www-form-urlencoded`, send a pre-encoded string body and set
the matching `content-type` header explicitly:

```json
{
  "id": "exchange_code",
  "kind": "request",
  "method": "POST",
  "connector_id": "<slack_oauth_connector_id>",
  "path": "/api/oauth.v2.access",
  "headers": { "content-type": "application/x-www-form-urlencoded" },
  "body": "code=${input.code}&client_id=${cred.slack_oauth.client_id}&client_secret=${cred.slack_oauth.client_secret}"
}
```

## Typed JSON bodies and arrays

A body leaf whose value is a **whole-value placeholder** — the field is
exactly `"${ref}"` with nothing around it — carries the referenced value's
**native JSON type** onto the wire. A number stays a number, an array stays
an array, an object stays an object. Only when you wrap the placeholder in
surrounding text (a **mixed string**, e.g. `"id-${ref}"`) does the engine
stringify the substituted value. So choose the form deliberately:

```json
{
  "body": {
    "limit": "${input.limit}",          // whole-value → wire gets a number 100
    "fields": "${scope.pick.data.cols}", // whole-value → wire gets an array
    "label": "batch-${input.run_id}"      // mixed string → wire gets "batch-42"
  }
}
```

This is what lets a dynamically-built array reach the API as a real JSON
array rather than a quoted string. Compute the array in a prior transform,
then reference it whole:

```json
{
  "id": "append_children",
  "kind": "request",
  "method": "PATCH",
  "connector_id": "<connector_id>",
  "path": "/blocks/${input.parent_id}/children",
  "headers": { "content-type": "application/json" },
  "body": { "children": "${scope.build_blocks.data}" }
}
```

Here `build_blocks` returns an array; because `children` is a whole-value
leaf, the upstream API receives `{"children": [ … ]}` with a genuine array,
not `{"children": "[object Object],…"}`. If you instead need a single
templated string built from several refs, use a mixed string and accept that
the result is text.

## Read-only POSTs — mark them `side_effects: "read"`

Method does not equal intent. Plenty of APIs expose **search / query**
endpoints over `POST` (the criteria are too big for a query string) that
mutate nothing — they only read. The runtime classifies steps as write by
HTTP method by default, so a dry-run will **HOLD** such a step as if it were
a send. Tell the runtime the truth: set `side_effects: "read"` on the step
so dry-run executes it live and the judge sees real data.

```json
{
  "id": "search_records",
  "kind": "request",
  "method": "POST",
  "connector_id": "<connector_id>",
  "path": "/v1/records/search",
  "headers": { "content-type": "application/json" },
  "body": { "filter": { "status": "open" }, "limit": 50 },
  "side_effects": "read"
}
```

Use this ONLY for endpoints that genuinely read (search, query, list,
lookup, report). A `POST` that creates, updates, or sends stays a write —
do not mislabel it to dodge the dry-run hold. `side_effects` is an existing
step field; there is no new schema to invent.

## Auth modes

The auth mode is set on the connector, not the step. The step just uses
`${cred.<slug>.<field>}` where needed. The four supported modes:

| Mode | What the driver injects | Credential fields it reads |
|---|---|---|
| `bearer` | `Authorization: Bearer <token>` header | `token` |
| `header` | Arbitrary header(s) from config | custom |
| `basic` | `Authorization: Basic <base64(user:pass)>` | `username`, `password` |
| `oauth2` | Refreshes and injects `Authorization: Bearer <access_token>` | `client_id`, `client_secret`, `refresh_token` |

For header auth (e.g. a service using `X-API-Key`), the connector's auth
config names the header and the step references the credential:

```json
{
  "connector": "mystery_service",
  "auth": { "mode": "header", "header": "X-API-Key", "value_from": "cred.mystery.api_key" }
}
```

Then any step using this connector automatically gets that header. You almost
never set auth headers manually in the step.

## Pagination

Set `pagination` on the step. The driver follows the spec until the terminator,
concatenating `data`:

### Offset

```json
{
  "pagination": {
    "strategy": "offset",
    "page_size": 100,
    "offset_param": "offset",
    "limit_param": "limit",
    "stop_when_empty_path": "results"
  }
}
```

### Page

```json
{
  "pagination": {
    "strategy": "page",
    "page_size": 50,
    "page_param": "page",
    "limit_param": "per_page",
    "start_page": 1
  }
}
```

### Cursor

```json
{
  "pagination": {
    "strategy": "cursor",
    "cursor_request_param": "after",
    "cursor_response_path": "paging.next.after",
    "page_size": 100
  }
}
```

When pagination is set, the envelope's `data` is the concatenated array of
items across pages. `status_code` reflects the last page's status. The driver
caps at MAX_PAGES = 1000 iterations.

## Retries and 429

Retry behaviour is configured by **direct fields on the request step** —
there is no nested `onError` object. Defaults:

- GET / HEAD / OPTIONS retry on 5xx + 429 + connection errors
- POST / PUT / PATCH / DELETE retry on 429 + connection errors only
  (idempotency rule — non-idempotent verbs do not retry on 5xx)

Override per step:

```json
{
  "id": "list_with_retries",
  "kind": "request",
  "method": "GET",
  "connector_id": "<flaky_api_connector_id>",
  "path": "/v1/items",
  "max_retries": 3,
  "retry_backoff_ms": 500,
  "retry_on_status": [502, 503, 504]
}
```

The driver honors `Retry-After` on 429 (seconds or HTTP-date) — it overrides
`retry_backoff_ms` for that one wait. `retry_on_status` adds extra status
codes on top of the defaults.

Workflow-level error policy is `on_error: "fail" | "continue"` directly on
the step (defaults to `fail`). `continue` keeps the run going past a failed
step rather than aborting the whole workflow.

## Referencing credentials

```json
{
  "headers": {
    "Authorization": "Bearer ${cred.notion.token}",
    "Notion-Version": "${connector.notion.config.api_version}"
  }
}
```

If the connector is already configured with `bearer` auth, the first header
line is redundant. Keep step configs lean; push repeated concerns to the
connector.

## Common pitfalls

- **Hardcoding the base URL.** Use `${connector.<slug>.base_url}` if you ever
  need to build a URL manually (e.g. for a redirect), never the literal host.
- **Setting auth headers manually when the connector already has auth.** This
  doubles up and often produces `401` because your header overrides the driver's.
- **Passing JSON body without `content-type`.** The driver defaults to
  `application/json` when body is an object, but if you set `headers.content-type`
  to something else, you're on the hook.
- **Forgetting `items_path` on pagination.** Without it the driver concatenates
  raw page envelopes instead of flattening items.
- **Ignoring 429 in workflows that loop.** A loop of 1000 requests with no
  retry mode on the child step will explode on the first rate-limit. Always set
  retry + respect `Retry-After`.
- **`path` starting with the full URL.** `path` is relative to `base_url`. A
  leading `https://` produces malformed URLs. The driver warns but doesn't block.

## See also

- `sk-concepts.md` — placeholder tokens and envelope shape.
- `data-handling.md` — trimming HTTP responses with `data_selector`.
- `error-recovery.md` — `http_4xx`, `http_5xx`, and `permission_denied` recovery.
