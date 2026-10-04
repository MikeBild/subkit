---
slug: webhooks-and-triggers
scope: global
title: Webhooks & Triggers
description: Mental model for how sk starts a workflow — request, webhook, or schedule trigger — plus inbound signed ingress. Thin pointer; the full reference lives in the sk-ref-webhooks knowledge source.
activates_when: [{"kind":"intent_keyword","word":"webhook"},{"kind":"intent_keyword","word":"inbound hook"},{"kind":"intent_keyword","word":"trigger"},{"kind":"intent_keyword","word":"schedule"},{"kind":"intent_keyword","word":"cron"}]
side_effects: read
idempotency: none
maturity: stable
tags: [sk-platform-reference, webhooks, triggers, schedule, cron]
version: 1
---

# Webhooks & Triggers

## Mental model

Every workflow has one optional `trigger` block that decides how its execution starts. Omit it and the workflow is `request`-triggered — the historical default. A `webhook` or `schedule` trigger is **reverse-bound**: saving the workflow upserts the matching ingress/schedule row keyed on `(tenant_id, workflow_id)`; deleting or version-rotating it removes the row.

## Key facts

- **Three trigger kinds**: `request` (on demand via chat, CLI, MCP `run_workflow`, or HTTP execution start), `webhook` (a provider POSTs a signed event), and `schedule` (a cron cadence fires on a clock in a declared IANA timezone).
- **Public inbound ingress is `POST /v1/hooks/:slug`** — unauthenticated. The request **signature is the only gate**; no bearer token is read. The verifier runs over the exact raw body.
- **Verifiers**: `standard` (Standard Webhooks), `github` (HMAC-SHA256), `stripe`, and a `none`/skip path for trusted ingress only. A bad or missing signature returns HTTP 401 `{ error: "denied", reason }`.
- **Replay is idempotent**: dedup on the provider event id means a repeated event runs at most once and returns `{ deduped: true }`.
- **Binding management is separate and RBAC-gated**: `POST | GET | DELETE /v1/webhooks/inbound` (permissions `inbound_hook:read | write | delete`). The signing secret is write-only and stored encrypted. Reverse-bound triggers derive the public slug `wf-<workflow_slug>` and write a placeholder secret you must rotate before real traffic verifies.
- **Schedules**: `cron` (5-field or `every:N` shorthand) plus `tz`, optional `business_days_only` (skips weekends only — holidays are never inferred), and explicit `skip_dates` (`YYYY-MM-DD`).

## Read-only MCP tools

`list_inbound_hooks` (no input) and `get_inbound_hook({ id })` inspect bindings. To run a workflow on demand use `run_workflow` or the per-workflow `wf_<slug>` tool. Tool names use underscores, never dots.

## Get the full reference

This skill is intentionally thin. For exact request/response shapes, the signature-verifier wire details, the denial-reason table, the inbound processing pipeline, the trigger schema, and audit action names, call:

```
search_knowledge({ query: "<your question>", tags: ["sk-platform-reference"] })
```

The exhaustive content lives in the knowledge source slug `sk-ref-webhooks`.
