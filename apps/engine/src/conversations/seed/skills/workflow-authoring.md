---
slug: workflow-authoring
scope: global
title: Authoring Workflows In A Conversation
description: The canonical recipe for turning a user intent into a committed subkit workflow draft.
gates_tools: []
version: 1
---

# Authoring Workflows In A Conversation

This skill describes the happy path for building a workflow when the user is
talking to you in a conversation. Follow the phases in order; skipping them
produces drafts that fail at runtime or in review.

## The six-phase flow

1. **`get_engine_status`** — confirm the engine is up, the tenant is resolved,
   and you're in the right environment. Fail fast here.
2. **`list_connectors`** — see what's already wired. The user rarely volunteers
   that "we already have a HubSpot connector called `hubspot_prod`", but it's
   almost always true.
3. **`probe_connector`** — for each connector you plan to use, verify the
   credential resolves and the base URL responds. This catches 80% of
   `placeholder_unresolved` and `http_4xx` errors before they become workflow bugs.
4. **`load_skill`** — pull the driver-specific skill (`http-connectors`,
   `postgres-connectors`, `s3-connectors`, `graphql-connectors`) plus any domain
   skills the tenant has seeded. Read them fully before proposing steps.
5. **`propose_step`** (incremental) or **`build_workflow`** (one-shot) — emit step
   drafts. Each `propose_step` returns a dry-run result you can inspect; if a
   step's envelope doesn't match what downstream expects, edit before moving on.
6. **`commit_draft`** — once all steps run green and the outputTransform shape
   matches the intent, commit. Commits are cheap; runs are where governance kicks in.

For request steps, use the current flattened shape: `connector_id`, `method`,
`path`, `query`, `headers`, `body`, and `graphql` live directly on the step.
Do not wrap them in `config`.

## `propose_step` vs `build_workflow`

| Question | Use `build_workflow` | Use `propose_step` (one per step) |
|---|---|---|
| Does the user know the full shape up-front? | Yes | No, we're exploring |
| Are all connectors already probed and green? | Yes | Some may need discovery |
| More than 5 steps, or any loop/branch/parallel? | Prefer incremental anyway | Yes |
| User has pasted a schema or example payload? | Yes, one-shot is faster | Either |

Rule of thumb: **default to `propose_step`**. The round-trip of seeing each
envelope prevents compounding errors. Reserve `build_workflow` for trivial
linear 2–4 step workflows where the user has given you an example payload.

## `data_selector` vs transform step vs `outputTransform`

Three places you can reshape data. Each has a different purpose:

| Where | Scope | When to use |
|---|---|---|
| Step-level `data_selector` | Trims what this step's `.data` looks like to **downstream** | Drop heavy fields (full HTML bodies, base64 blobs) early so scope stays small |
| Dedicated `transform` step | Produces a new step with its own envelope | Reshape across multiple upstream steps, or compute derived values |
| Workflow-level `outputTransform` | The final payload the caller sees | Hide internal plumbing, expose only the contract |

Example combining all three:

```json
{
  "steps": [
    {
      "id": "fetch_orders",
      "kind": "request",
      "connector_id": "00000000-0000-0000-0000-000000000001",
      "method": "GET",
      "path": "/admin/api/2024-04/orders.json",
      "data_selector": "$.orders.{ 'id': id, 'total': total_price, 'customer_email': email }"
    },
    {
      "id": "fetch_customers",
      "kind": "request",
      "connector_id": "00000000-0000-0000-0000-000000000002",
      "method": "GET",
      "path": "/crm/v3/objects/contacts",
      "data_selector": "$.results.{ 'email': properties.email, 'lifecycle': properties.lifecyclestage }"
    },
    {
      "id": "merge",
      "kind": "transform",
      "expression": "$scope.fetch_orders.data.{ 'order_id': id, 'total': total, 'lifecycle': $scope.fetch_customers.data[email = $$.customer_email].lifecycle }",
      "language": "jsonata"
    }
  ],
  "output_transform": "{ 'report': $scope.merge.data, 'generated_at': $now() }"
}
```

`data_selector` trimmed the Shopify response from ~40 fields to 3, keeping scope
small. The `merge` transform joined the two lists by email. `outputTransform`
added a timestamp envelope for the caller.

## `input_schema` vs `input_schema_sample`

- **`input_schema`** — a JSON Schema. The engine validates workflow input against
  it before the first step runs. Use when the shape is stable and the caller is
  a trusted connector boundary (another workflow, a webhook with a known contract).
- **`input_schema_sample`** — a literal example payload. Used for dev-time
  dry-runs and LLM context; **not** enforced at runtime. Use when the shape is
  still evolving and over-constraining would slow down iteration.

Both can coexist. A common pattern:

```json
{
  "input_schema": {
    "type": "object",
    "required": ["tenant_id"],
    "properties": { "tenant_id": { "type": "string", "format": "uuid" } }
  },
  "input_schema_sample": {
    "tenant_id": "6a3c8f2e-1d5b-4b7a-9c4e-8f2b1d5a3c7e",
    "options": { "dry_run": true }
  }
}
```

## Multi-step structures

### Loops

Iterate over an array from a prior step. Each iteration gets a `scope.<as>`
binding with its own envelope (`$scope.<as>.data` is the current item).

```json
{
  "id": "send_emails",
  "kind": "loop",
  "over": "$scope.segment.data.users",
  "body": ["send"],
  "item_var": "user"
}
```

### Branches

First case whose `when` evaluates truthy runs. `default` runs if none match.

```json
{
  "id": "route",
  "kind": "branch",
  "config": {
    "cases": [
      { "when": "$scope.classify.data.tier = 'enterprise'", "steps": [ /* white-glove path */ ] },
      { "when": "$scope.classify.data.tier = 'pro'",        "steps": [ /* pro path */ ] }
    ],
    "default": [ /* self-serve path */ ]
  }
}
```

### Parallel

`join: "all"` waits for every branch. `join: "any"` resolves on the first. Each
branch has its own isolated scope but can read `$scope.<upstream_id>.data` from
steps that finished before the `parallel`.

```json
{
  "id": "fanout",
  "kind": "parallel",
  "config": {
    "branches": [
      [ { "id": "write_pg", "kind": "request", "config": { /* postgres INSERT */ } } ],
      [ { "id": "write_s3", "kind": "request", "config": { /* s3 put */ } } ]
    ],
    "join": "all"
  }
}
```

## Common pitfalls

- **Skipping `probe_connector`.** You'll spend five turns debugging a credential
  that never existed. Probe first, every time.
- **Committing before every step has a green dry-run.** `commit_draft` doesn't
  run the steps. Bad drafts commit cleanly and then fail at first invocation.
- **Confusing `output_transform` with `data_selector`.** `output_transform` runs
  once, at the end. `data_selector` runs per step. Using `output_transform` to
  trim an early step wastes scope space for the whole run.
- **Nested loop id collisions.** `loop.body[].id` values must be unique across
  the whole workflow, not just within the body. The validator rejects duplicates.
- **Writing JSONata that assumes arrays.** `$scope.foo.data.items` when `items`
  is missing returns `undefined`, which then blows up downstream. Guard with
  `$scope.foo.data.items ? $scope.foo.data.items : []`.
- **Expecting `call` to inherit parent scope.** A called workflow starts with a
  fresh scope; it only sees what's passed through `config.input`.

## See also

- `subkit-concepts.md` — the envelope and placeholder tokens.
- `data-handling.md` — JSONata cheatsheet and reshaping patterns.
- `error-recovery.md` — recovering from tool errors mid-conversation.
