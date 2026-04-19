---
slug: http-connectors
scope: global
title: HTTP Connectors
description: Driver specifics for the HTTP connector — methods, auth, pagination, retries.
gates_tools: []
version: 1
---

# HTTP Connectors

The `http` driver is the most commonly used connector in subkit. It speaks
REST/JSON over HTTPS, handles auth, retries, and pagination, and returns the
standard envelope.

## Step shape

```json
{
  "id": "list_contacts",
  "kind": "request",
  "config": {
    "connector": "hubspot",
    "method": "GET",
    "path": "/crm/v3/objects/contacts",
    "query": { "limit": 100 },
    "headers": { "accept": "application/json" },
    "body": null
  }
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
  "config": {
    "connector": "github",
    "method": "GET",
    "path": "/search/issues",
    "query": { "q": "repo:${input.repo} is:open", "per_page": 50 }
  }
}
```

### POST with JSON

```json
{
  "id": "create_ticket",
  "kind": "request",
  "config": {
    "connector": "zendesk",
    "method": "POST",
    "path": "/api/v2/tickets.json",
    "headers": { "content-type": "application/json" },
    "body": {
      "ticket": {
        "subject": "${input.subject}",
        "comment": { "body": "${input.body}" },
        "requester_id": "${scope.lookup_user.data.id}"
      }
    }
  }
}
```

### PATCH with a conditional field

```json
{
  "id": "update_deal",
  "kind": "request",
  "config": {
    "connector": "hubspot",
    "method": "PATCH",
    "path": "/crm/v3/objects/deals/${scope.find_deal.data.id}",
    "body": { "properties": { "dealstage": "${input.target_stage}" } }
  }
}
```

### DELETE

```json
{
  "id": "revoke_token",
  "kind": "request",
  "config": { "connector": "auth0", "method": "DELETE", "path": "/api/v2/device-credentials/${scope.find_cred.data.id}" }
}
```

### Form-encoded body

Set `body_encoding: "form"`. The driver will serialize `body` as
`application/x-www-form-urlencoded`:

```json
{
  "id": "exchange_code",
  "kind": "request",
  "config": {
    "connector": "slack_oauth",
    "method": "POST",
    "path": "/api/oauth.v2.access",
    "body_encoding": "form",
    "body": {
      "code": "${input.code}",
      "client_id": "${cred.slack_oauth.client_id}",
      "client_secret": "${cred.slack_oauth.client_secret}"
    }
  }
}
```

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
    "mode": "offset",
    "limit_param": "limit",
    "offset_param": "offset",
    "page_size": 100,
    "items_path": "$.results",
    "total_path": "$.total"
  }
}
```

### Page

```json
{
  "pagination": {
    "mode": "page",
    "page_param": "page",
    "start_page": 1,
    "page_size": 50,
    "page_size_param": "per_page",
    "items_path": "$.data",
    "has_more_path": "$.has_next"
  }
}
```

### Cursor

```json
{
  "pagination": {
    "mode": "cursor",
    "cursor_param": "after",
    "cursor_path": "$.paging.next.after",
    "items_path": "$.results"
  }
}
```

When pagination is set, the envelope's `data` is the concatenated array of
items across pages. `status_code` reflects the last page's status. Cap runaway
pagination with `max_pages` (defaults to 100).

## Retries and 429

Default `onError` for HTTP steps is `fail`. To retry on 5xx or network errors:

```json
{
  "onError": {
    "mode": "retry",
    "max_retries": 3,
    "backoff_ms": 500,
    "backoff_strategy": "exponential"
  }
}
```

The driver special-cases `429 Too Many Requests`: if a `Retry-After` header is
present (seconds or HTTP-date), the driver honors it, overriding `backoff_ms`.
You still need `mode: "retry"` for the retry to happen at all.

Increase `max_retries` to 5+ only for flaky downstreams you've confirmed via
`probe_connector`. Past 5, the step's wall-clock becomes unpredictable;
consider splitting the work instead.

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

- `subkit-concepts.md` — placeholder tokens and envelope shape.
- `data-handling.md` — trimming HTTP responses with `data_selector`.
- `error-recovery.md` — `http_4xx`, `http_5xx`, and `permission_denied` recovery.
