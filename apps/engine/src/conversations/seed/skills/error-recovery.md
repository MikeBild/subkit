---
slug: error-recovery
scope: global
title: Authoring-Time Error Recovery
description: Canonical tool-error shape and recovery routine for errors that surface WHILE the assistant is building a connector or workflow in a conversation. For failures of workflows that have already been committed and run, see `troubleshooting-workflow-failures`.
gates_tools: []
version: 2
auto_load: true
trigger_keywords: [error, failed, failure, broken, debug, fix, http_4xx, http_5xx, 4xx, 5xx, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504, placeholder_unresolved, permission_denied, validation_failed, step_timeout, filter_fail, connector_not_found, ok false, tool error]
---

# Error Recovery

Tools in subkit return a uniform error envelope when they fail. This skill is
the playbook: how to read it, how to diagnose, and how to fix without
thrashing.

## Canonical tool error shape

Every tool's failure returns:

```json
{
  "ok": false,
  "error": {
    "code": "<machine_readable_code>",
    "message": "<human_readable_summary>",
    "details": { /* optional, shape depends on code */ }
  }
}
```

Never trust a tool call that returned `ok: false` — even partial results in
`details` are diagnostic-only, not payload.

## Common codes and what they mean

| Code | Meaning | First thing to try |
|---|---|---|
| `placeholder_unresolved` | A `${...}` token referenced a credential, connector, input, or scope path that doesn't exist | Read `details.token`; check spelling, env, or prior step's envelope |
| `permission_denied` | The caller lacks the permission on this resource | Read `details.permission` + `details.resource`; do not retry |
| `connector_not_found` | Referenced connector slug does not exist in this env | `list_connectors` to see what exists |
| `step_timeout` | Step exceeded its wall-clock limit | Check downstream health via `probe_connector`; consider pagination or splitting |
| `http_5xx` | Downstream 500/502/503/504 | Retry with backoff; if persistent, it's a vendor problem |
| `http_4xx` | Downstream 4xx (except 429) | Read `details.body`; fix the request shape |
| `filter_fail` | A branch `when` or JSONata filter errored | Read the expression; usually `$scope.foo.data` has `undefined` where code expected an array |
| `validation_failed` | Input didn't match `input_schema` | Read `details.violations`; fix the caller's input or widen the schema |

## The recovery routine

When a tool call or a step fails mid-conversation, do these five things in
order. Do not skip.

### 1. Read the error

Don't summarize. Look at the raw envelope. `code`, `message`, and every key
of `details`. Ninety percent of fixes are unblocked by reading `details.token`
or `details.body`.

### 2. Load the relevant skill

Based on the code:

- `placeholder_unresolved` → `load_skill("subkit-concepts")` to re-check token
  shapes, or the relevant driver skill if the token refers to a connector.
- `http_4xx` / `http_5xx` → `load_skill("http-connectors")`.
- Postgres error → `load_skill("postgres-connectors")`.
- `permission_denied` → `load_skill("rbac-and-scopes")`.
- `filter_fail` / shape mismatch → `load_skill("data-handling")`.

Skills are loaded on-demand; the context cost is paid once per conversation.

### 3. `search_knowledge`

Tenants often seed internal knowledge sources with vendor-specific quirks
("HubSpot API: dealstage must be a pipeline-scoped internal id, not a label").
`search_knowledge` hits those. Query with the vendor name + the specific error
message keyword.

### 4. `probe_connector`

If the error is at the connector boundary, probe it. Probe runs a canonical
shallow request (for HTTP: GET `base_url`; for Postgres: `SELECT 1`; for S3:
`HeadBucket`; for GraphQL: a minimal introspection query) and returns the
envelope. This isolates whether the bug is in your step config, the connector
config, or the credential.

### 5. Edit the draft

Only now edit. With the error read, the skill loaded, the knowledge searched,
and the connector probed, you have the information to make a targeted fix.
Re-dry-run the specific step before moving on.

## When to retry vs give up vs ask the user

| Situation | Action |
|---|---|
| `http_5xx` on first try, probe healthy | Retry once with backoff; if it persists, move to probe-unhealthy |
| `http_5xx` sustained + probe_connector shows 5xx | Stop. Vendor incident. Tell the user. |
| `http_4xx` 400/422 | Read `details.body`. The request is wrong. Fix and retry. |
| `http_4xx` 401/403 | Connector auth or scope issue. Do not retry the same shape. |
| `http_4xx` 404 | Either the resource truly doesn't exist, or the path template is wrong. Probe first. |
| `permission_denied` | Do not retry. Surface to the user; ask for role change or scope reduction. |
| `validation_failed` | Fix the input or schema. Never retry with the same input. |
| `step_timeout` on a pagination step | Lower page size, add `max_pages`, or split the workflow. |
| `placeholder_unresolved` on `${cred.foo.bar}` | Credential either doesn't exist in this env, or the field name is wrong. Ask the user to create/rotate. |
| `filter_fail` | Almost always a scope path error. Reread the upstream envelope. |
| Same error three turns in a row | Stop. Ask the user for guidance; do not thrash. |

## Worked example

Turn 1 — user asks "list all HubSpot deals closed last week".

Turn 2 — you dry-run:

```json
{
  "ok": false,
  "error": {
    "code": "http_4xx",
    "message": "400 Bad Request",
    "details": {
      "status": 400,
      "body": { "status": "error", "message": "property 'closedate' is not searchable; use 'hs_closedate'", "correlationId": "..." }
    }
  }
}
```

Turn 3 — you: read error (property name issue), `load_skill("http-connectors")`
(refresh pagination / query patterns), `search_knowledge("hubspot closedate")`
(finds: "HubSpot renames many user-visible properties; internal name is the
`hs_`-prefixed variant"), edit step to use `hs_closedate`, re-dry-run.

Turn 4 — green. Commit.

Three turns from failure to commit. Skipping step 3 (knowledge search) would
have cost another round-trip guessing `closedate_unix` or similar.

## Common pitfalls

- **Retrying a 4xx as if it were a 5xx.** 4xx means "your request was wrong";
  retrying the same request gets the same error. Fix first.
- **Ignoring `details.body`.** The vendor's error message is the shortest
  path to a fix. Read it.
- **Re-running `commit_draft` after a dry-run error.** Commit doesn't re-run
  the step. You'll commit a known-broken draft.
- **Assuming `permission_denied` is a bug.** It's the correct outcome until
  RBAC changes. Surface it; don't work around it.
- **Looping through retries without bounds.** Three failed turns on the same
  error means your mental model is wrong. Ask the user, don't thrash.
- **Probing the wrong env.** `probe_connector` runs in the current
  conversation's env. If you're authoring for prod but the conversation is
  dev-scoped, probe results may not reflect prod reality.

## See also

- `subkit-concepts.md` — placeholder tokens and scope paths.
- `workflow-authoring.md` — the six-phase authoring flow (probe is step 3).
- `self-healing.md` — how repeated failures become patch candidates.
- `rbac-and-scopes.md` — `permission_denied` recovery.
