---
slug: subkit-concepts
scope: global
title: Subkit Core Concepts
description: The minimum mental model an agent needs to author, run, and reason about subkit workflows.
gates_tools: []
version: 1
---

# Subkit Core Concepts

Subkit is a governance-first workflow engine. Every workflow is a list of **steps**
executed by the engine, backed by PostgreSQL, and scoped to a tenant. This document
is the canonical primer for agents authoring or editing workflows.

## Workflow shape

A workflow is an ordered array of steps plus optional top-level metadata:

```json
{
  "id": "weekly_sales_digest",
  "name": "Weekly sales digest",
  "input_schema": { "type": "object", "properties": { "week": { "type": "string" } } },
  "steps": [ /* ordered step objects */ ],
  "outputTransform": "$scope.send_email.data"
}
```

Each **step** has at minimum:

```json
{
  "id": "list_orders",
  "kind": "request",
  "config": { /* kind-specific */ },
  "data_selector": "$",
  "onError": { "mode": "fail" }
}
```

- `id` — unique within the workflow, snake_case. Referenced by downstream steps.
- `kind` — one of the eight kinds listed below.
- `config` — shape is kind-specific.
- `data_selector` — optional JSONata that trims the envelope's `data` before downstream steps see it.
- `onError` — behavior when the step fails.

## The 8 step kinds

| Kind | Purpose | One-line config example |
|---|---|---|
| `request` | Call an external system via a connector (http / graphql / postgres / s3) | `{ "connector": "hubspot", "method": "GET", "path": "/crm/v3/objects/contacts" }` |
| `transform` | Reshape data with JSONata, no I/O | `{ "expression": "$scope.list_orders.data.results[amount > 100]" }` |
| `wait` | Pause for a duration or until a timestamp | `{ "seconds": 30 }` |
| `branch` | Conditional routing; executes the first matching case | `{ "cases": [{ "when": "$scope.classify.data.tier = 'gold'", "steps": [...] }], "default": [...] }` |
| `parallel` | Run child step groups concurrently, join on completion | `{ "branches": [[...stepsA], [...stepsB]], "join": "all" }` |
| `loop` | Iterate over an array and run a child step body per item | `{ "over": "$scope.list_orders.data.results", "as": "order", "body": [...] }` |
| `call` | Invoke another workflow as a subroutine | `{ "workflow": "send_receipt", "input": { "order_id": "$scope.loop_item.data.id" } }` |
| `tool` | Invoke a registered engine tool (e.g. hash, uuid, audit write) | `{ "tool": "uuid.v4" }` |

## The step output envelope

**Every** step returns an envelope. This is non-negotiable and a constant source of
author bugs:

```json
{
  "data": { /* the actual payload */ },
  "status_code": 200,
  "headers": { "content-type": "application/json" },
  "error": null,
  "duration_ms": 142
}
```

Downstream steps access fields via the `$scope` token:

- `$scope.list_orders.data.results` — the payload.
- `$scope.list_orders.status_code` — the HTTP (or driver-equivalent) code.
- `$scope.list_orders.duration_ms` — wall-clock time in ms.
- `$scope.list_orders.headers."x-request-id"` — response headers (HTTP only).

`$scope.list_orders` **by itself is the envelope** — you almost never want that.
Writing `$scope.list_orders.results` drops the payload silently and is the single
most common authoring bug.

## Placeholder tokens

Five token families can appear inside step configs and request bodies. The engine
resolves them at step-start time:

| Token | Resolves to | Example |
|---|---|---|
| `${cred.<slug>.<field>}` | Decrypted credential field from the credential store | `${cred.hubspot.api_key}` |
| `${connector.<slug>.base_url}` | Connector's `base_url` | `${connector.hubspot.base_url}/crm/v3/objects` |
| `${connector.<slug>.config.<path>}` | Arbitrary connector config dotted-path | `${connector.warehouse.config.region}` |
| `${input.<path>}` | Workflow input, validated against `input_schema` | `${input.week}` |
| `${scope.<step_id>.<path>}` | Envelope field from a prior step (scope form) | `${scope.list_orders.data.total}` |

`${scope...}` and `$scope...` are two interchangeable forms for the same scope
access. Use `${scope.foo.data.x}` inside string-interpolated configs (URLs, headers,
SQL text), and `$scope.foo.data.x` inside JSONata expressions (data_selector,
transform.expression, branch.when).

## JSONata basics

`data_selector` and the `transform` step both use JSONata. Common patterns:

- **Select a field:** `$scope.list_orders.data.results`
- **Filter:** `$scope.list_orders.data.results[status = 'open']`
- **Project:** `$scope.list_orders.data.results.{ "id": id, "amount": amount }`
- **Aggregate:** `$sum($scope.list_orders.data.results.amount)`
- **Count:** `$count($scope.list_orders.data.results)`
- **Join strings:** `$join($scope.list_orders.data.results.name, ", ")`
- **Null-safe:** `$scope.list_orders.data.results ? $scope.list_orders.data.results : []`

## Environments and credential scoping

Every tenant has at least two environments: `dev` and `prod`. Credentials are
created under a specific env; `${cred.hubspot.api_key}` resolves to the credential
that matches **both** the slug `hubspot` and the environment the run is executing
under. The same connector may point to different base URLs per env by using
`${connector.<slug>.config.*}` paths set per env.

This means: a workflow written against dev connectors runs unchanged in prod as
long as connector slugs match and required credentials exist in the prod env.

## Example: a tiny 3-step workflow

```json
{
  "id": "enrich_new_signups",
  "name": "Enrich new signups",
  "input_schema": { "type": "object", "required": ["since"], "properties": { "since": { "type": "string" } } },
  "steps": [
    {
      "id": "fetch_signups",
      "kind": "request",
      "config": {
        "connector": "warehouse",
        "method": "SELECT",
        "query": "SELECT id, email FROM users WHERE created_at > $1",
        "params": ["${input.since}"]
      }
    },
    {
      "id": "enrich",
      "kind": "loop",
      "config": {
        "over": "$scope.fetch_signups.data",
        "as": "user",
        "body": [
          {
            "id": "lookup_company",
            "kind": "request",
            "config": {
              "connector": "clearbit",
              "method": "GET",
              "path": "/v2/people/find?email=${scope.user.data.email}"
            },
            "onError": { "mode": "fallback", "fallback_value": { "company": null } }
          }
        ]
      }
    },
    {
      "id": "shape",
      "kind": "transform",
      "config": {
        "expression": "$scope.enrich.data.{ 'email': email, 'company': lookup_company.data.company }"
      }
    }
  ],
  "outputTransform": "$scope.shape.data"
}
```

## Common pitfalls

- **Forgetting `.data` on `$scope`.** `$scope.step1.foo` reads a field on the
  envelope (which doesn't exist). You want `$scope.step1.data.foo`.
- **Mixing placeholder shapes.** `${cred.foo}` (missing field) or
  `${connector.foo.api_key}` (credentials are not on the connector) both fail
  with `placeholder_unresolved`.
- **Hardcoding secrets.** Never inline API keys, tokens, or passwords. Always use
  `${cred.<slug>.<field>}`. The engine scans drafts for common secret shapes and
  refuses commits containing them.
- **Cross-env assumptions.** A dev credential does not resolve in prod. Test with
  `probe_connector` per environment before committing.
- **Shadowing step ids.** Two steps with the same `id` inside one workflow silently
  shadow each other in `$scope`; the validator now rejects this, but nested
  `loop.body` ids must also be unique.
- **Treating `wait.seconds` as async.** A `wait` step blocks the run; use it only
  for short pauses (backoff, rate-limit cooldowns). For long delays, split into
  two workflows triggered by a scheduler.

## See also

- `workflow-authoring.md` — how to actually build these in a conversation.
- `data-handling.md` — deep dive on the envelope, data_selector, and JSONata.
- `error-recovery.md` — reading tool errors from the conversation surface.
