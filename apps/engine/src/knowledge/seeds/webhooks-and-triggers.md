---
slug: sk-ref-webhooks
name: subkit Platform Reference — Webhooks & Triggers
description: How subkit receives inbound webhooks (public signed ingress, replay dedup, CRUD bindings) and how workflow triggers (request | webhook | schedule) start executions.
tags: [sk-platform-reference, webhooks, triggers, schedule, cron, inbound, signature-verification]
scope: global
version: 3
---

# Webhooks & Triggers — overview

subkit starts a workflow execution in three ways, selected by the workflow's optional `trigger` block:

- `request` — on demand (chat, CLI, MCP `run_workflow`, HTTP execution start). This is the default when no `trigger` is set.
- `webhook` — an external provider POSTs a signed event to a public ingress URL; subkit verifies the signature and enqueues an execution.
- `schedule` — a cron cadence fires the workflow on a clock, in a declared timezone.

Two surfaces exist for inbound webhooks:
- Public, unauthenticated ingestion: `POST /v1/hooks/:slug` — the signature IS the gate, no bearer token.
- Authenticated CRUD over slug→workflow bindings: `POST | GET | DELETE /v1/webhooks/inbound` — RBAC-gated.

A workflow with a `webhook` or `schedule` trigger is "reverse-bound": activating
the definition reconciles its matching trigger binding. An inactive save does not
activate triggers. Webhook reconciliation selects only `origin: trigger` rows;
request and schedule activation remove only those reverse-bound inbound rows.
Separately managed `origin: crud` bindings retain their identity, verifier, event
filter, encrypted signing secret and active state through definition changes.
Archiving or deleting the workflow removes all its inbound bindings and records
the corresponding unbind audit entries.

Always inspect a transactional workflow's actual signed binding after activation
and before enabling its sender. If the binding disappeared, stop commissioning.
Recovery uses ordinary binding creation and a new normally reviewed workflow
version referencing its actual new ID. Never invent an old ID, bypass signature
verification or treat an existing execution authority as approval of a new source.

# Public inbound ingestion — POST /v1/hooks/:slug

Unauthenticated public endpoint. No bearer token is read or required — the request signature is the only auth.

Request:
- Method `POST`, path `/v1/hooks/:slug`.
- `:slug` resolves a single `webhooks_inbound` row (slug is globally unique across tenants via a composite unique index; routing happens before tenant resolution).
- Body is read raw (signature verifiers operate on the exact raw bytes). Headers are lowercased before verification.

Processing pipeline (in order):
1. Slug lookup → `not_found` (HTTP 404) if no binding.
2. Active check → `denied` reason `inactive` (HTTP 401) if the binding is inactive.
3. Resolve the binding's verifier. An unrecognised stored `verifier` (anything outside `standard` | `github` | `stripe`) → `denied` reason `unknown_verifier` (HTTP 401) with an actionable `hint` (accepted values + the note that `verify: "none"` is not a stored verifier — it maps to `standard` + skip).
4. Verify the signature with the binding's verifier, or skip if `native_verifier_config.skip === true` (the `verify: "none"` path). Failure → `denied` (HTTP 401) with the verifier's reason. The stored signing secret is decrypted **lazily** — only when a real signature check runs (AES-GCM, row-scoped AAD). On the skip path the secret is never touched, so a placeholder/garbage ciphertext (e.g. an un-rotated trigger placeholder) can never turn a skip delivery into an HTTP 500.
5. Event filter: if the binding declares `events: [...]` (non-empty), the normalized event `type` must be in the list, else `denied` reason `event_not_subscribed`. This filter applies on the skip path too — a trusted (skip) ingress with a non-empty allow-list still requires the delivery to carry a matching `webhook-type` header (a delivery without one normalizes to type `unknown` and is filtered out). Use `events: []` on a skip binding to accept any event.
6. Replay dedup on `(tenant_id, webhook_id, standard_webhook_id)` → `deduped` (HTTP 200, `{ deduped: true, inbound_id }`) on replay.
7. Resolve the workflow's current version → `denied` reason `workflow_unresolved` if the workflow has no current version.
8. Create an `executions` row and enqueue an `execution.run` job with `request_source = "webhook"`.

Response shapes:
- Accepted: HTTP 200 `{ accepted: true, inbound_id, execution_id, webhook_id }` (`webhook_id` is the normalized event id).
- Deduped replay: HTTP 200 `{ deduped: true, inbound_id }`.
- Denied: HTTP 401 `{ error: "denied", reason }` — reasons: `inactive`, `unknown_verifier`, `<verifier reason>`, `event_not_subscribed`, `workflow_unresolved`. The `unknown_verifier` denial additionally carries a `hint` string explaining the fix.
- Not found: HTTP 404 `{ error: "not_found" }`.

Execution input payload (passed to the workflow as `input`):
```
{ id, timestamp, type, headers, body }
```
`id`/`timestamp`/`type` come from the normalized event; `body` is the parsed JSON (or the raw string if not JSON); `headers` is the full lowercased header map.

# Signature verifiers

The binding's `verifier` picks the signature scheme. The verifier reads the exact raw body — never re-serialize before verifying.

- `standard` (Standard Webhooks): reads headers `webhook-id`, `webhook-timestamp`, `webhook-signature`; event `type` from `webhook-type` (default `unknown`). HMAC over `id.timestamp.body`.
- `github` (GitHub HMAC): reads `x-hub-signature-256` (HMAC-SHA256 of the raw body), `x-github-delivery` (event id), `x-github-event` (event type).
- `stripe`: reads `stripe-signature` (the `t=`/`v1=` scheme); timestamp-bound to defeat replay.
- `none` (trigger `verify: "none"`): maps to the `standard` verifier with `native_verifier_config = { skip: true }`, which bypasses the signature check entirely. Use only for trusted ingress (intra-VPC, mTLS-fronted). A stable normalized id is still synthesized — from `webhook-id` if present, else a SHA-256 hash of the body — so replay dedup still works. `webhook-timestamp` and `webhook-type` headers are honored if present. Because the signature is skipped, the stored secret is never decrypted on this path — a skip binding whose secret is still the reverse-bind placeholder (never rotated) accepts traffic normally.

`none`/`skip`/`insecure` are NOT valid values for the stored `verifier` column — the column only stores `standard` | `github` | `stripe`. The trigger-level `verify: "none"` is expressed as `verifier = "standard"` + `native_verifier_config.skip = true`, written by the reverse-bind path. A row that stored the literal `none` (e.g. a hand-written/legacy row) is denied `unknown_verifier`; re-save the workflow trigger (or recreate the binding) to fix it.

The CRUD `verifier: "custom"` value is accepted on input but stored as `standard`.

# Replay-id dedup

Backed by table `webhook_replay_seen`, unique index on `(tenant_id, webhook_id, standard_webhook_id)`.

- `standard_webhook_id` is the provider-native event id from the normalized event (`webhook-id`, `x-github-delivery`, the Stripe event id, or the synthesized skip id).
- Dedup is an `INSERT ... ON CONFLICT DO NOTHING RETURNING`; a row returned means "new" (proceed), no row means "already seen" (replay → `deduped`, no second execution).
- Replaying the same event id is therefore idempotent: at most one execution per `(webhook_id, event_id)`.

# Inbound binding CRUD — /v1/webhooks/inbound

Authenticated, RBAC-gated management of slug→workflow bindings.

Endpoints and required permissions:
- `POST /v1/webhooks/inbound` — create a binding. Permission `inbound_hook:write`. Returns HTTP 201.
- `GET /v1/webhooks/inbound` — list bindings for the tenant. Permission `inbound_hook:read`.
- `GET /v1/webhooks/inbound/{id}` — fetch one binding. Permission `inbound_hook:read` (resource-scoped to the id).
- `DELETE /v1/webhooks/inbound/{id}` — remove one binding. Permission `inbound_hook:delete` (resource-scoped). Returns `{ deleted: true }`.

All four require a bearer token. The public `POST /v1/hooks/:slug` ingress is deliberately left ungated — signature auth is the gate there.

Create body:
```
{
  slug,                          // public slug (the :slug in /v1/hooks/:slug)
  workflow_id,                   // uuid of the bound workflow
  verifier,                      // "standard" | "github" | "stripe" | "custom" ("custom" stored as "standard")
  secret,                        // signing secret (stored AES-GCM encrypted, never returned)
  native_verifier_config?,       // optional verifier-specific config
  active?                        // defaults true
}
```

Binding row fields (returned by list/get; the secret is never returned):
- `id`, `tenant_id`, `slug`, `workflow_id`, `verifier`, `active`, `created_at`, `updated_at`.
- `origin`: `"crud"` for bindings created via this API, `"trigger"` for rows reverse-bound from a workflow `webhook` trigger.

The signing secret is stored AES-GCM encrypted with a row-scoped AAD; it is write-only over the API.

# Reverse-binding from a webhook trigger

Saving a workflow with `trigger: { kind: "webhook" }` upserts a single `webhooks_inbound` row, idempotent on `(tenant_id, workflow_id)`:

- Public slug is derived from the workflow slug: `wf-<workflow_slug>` (truncated to 64 chars). Slugs are unique across the whole engine, so when that slug is already taken a short suffix is appended. The binding keeps its slug across workflow edits/renames; read the actual slug from the binding (`GET /v1/webhooks/inbound`) instead of assuming it.
- Verifier maps from the trigger's `verify`: `stripe-signature → stripe`, `github-hmac → github`, `none → standard` with `{ skip: true }`.
- `native_verifier_config` is written as `{ source, events }` (plus `skip: true` when `verify: "none"`).
- The signing secret is NOT carried on the trigger. On first bind a random placeholder ciphertext is written; the operator provisions the real secret out-of-band (via the CRUD create flow or secret rotation). With a placeholder secret a `standard`/`github`/`stripe` verifier will reject real traffic until the secret is rotated in.
- Deleting or version-rotating the workflow deletes the row(s).

Audit actions differ by `origin`:
- `trigger` rows emit `webhook.trigger.bound` / `webhook.trigger.unbound` (lifecycle) and `webhook.trigger.fired` / `webhook.trigger.failed_verification` (fire time).
- `crud` rows emit `webhook.inbound.created` / `webhook.inbound.deleted` and `webhook.inbound.received` / `webhook.inbound.denied`.

# Workflow trigger schema

The optional `trigger` block on a workflow definition is a discriminated union on `kind`. Omitting it equals `{ kind: "request" }`.

`request`:
```
{ kind: "request" }
```
On-demand only. No reverse binding. Every legacy workflow behaves as this.

`webhook`:
```
{
  kind: "webhook",
  source,                                  // free-form provider id ("stripe", "github-prod")
  events,                                  // string[] of accepted provider event names; [] = any
  verify                                   // "stripe-signature" | "github-hmac" | "none"
}
```
`events: []` accepts all events; a non-empty list drops events whose normalized `type` is not listed (audited `event_not_subscribed`). `verify: "none"` requires the binding row to exist but skips the signature check.

`schedule`:
```
{
  kind: "schedule",
  cron,                                    // 5-field cron "m h dom mon dow" or "every:N" shorthand
  tz,                                      // IANA timezone, e.g. "Europe/Berlin"; default "UTC"
  execution_mode?,                         // "prod" (default) or explicit "dev"
  business_days_only?,                     // true = skip weekend firings
  skip_dates?                              // string[] of "YYYY-MM-DD" dates to skip (holidays, freezes)
}
```
`cron` is validated at bind time. `tz` controls the wall-clock the cron lands on (passed to pg-boss). `execution_mode` is persisted with the schedule and copied into the queued execution; unattended automation defaults to `prod`, while short authoring loops must request `dev` explicitly. `business_days_only` skips Sat/Sun only — holiday calendars are never inferred; declare them explicitly in `skip_dates`. `skip_dates` entries must match `^\d{4}-\d{2}-\d{2}$` and are compared against the trigger's `tz` (the calendar day in the workflow's timezone). Schedule firing is reconciled by the scheduler; webhook firing by the inbound driver.

# MCP tools

Read-only inbound-hook tools exposed over MCP (category `tenant_read`):

- `list_inbound_hooks` — list inbound webhook bindings configured for the tenant. No input.
- `get_inbound_hook` — fetch one inbound binding by id. Input `{ id }` (uuid). Returns `{ ok: false, data: { error: "inbound_hook_not_found" } }` when absent.

To run a workflow on demand over MCP use `run_workflow` (or the per-workflow `wf_<slug>` tool). MCP tool names use underscores, never dots.

# Quick answers

- "URL to give a provider?" → `POST https://<engine-host>/v1/hooks/<slug>`. For a trigger-bound workflow the slug is usually `wf-<workflow_slug>`; read the exact one from `GET /v1/webhooks/inbound`.
- "Does the ingress need an API key?" → No. The signature is the auth. The CRUD `/v1/webhooks/inbound` routes do need a bearer token.
- "Why am I getting 401?" → `inactive` binding, bad/missing signature, unknown verifier, `event_not_subscribed`, or `workflow_unresolved`. Check the binding's `active`, `verifier`, secret, and the workflow's current version.
- "Why did a repeated event not run twice?" → replay dedup on the provider event id; the duplicate returns `{ deduped: true }`.
- "Set up a daily run at 07:00 Berlin, weekdays only, skip holidays?" → `trigger: { kind: "schedule", cron: "0 7 * * *", tz: "Europe/Berlin", execution_mode: "prod", business_days_only: true, skip_dates: ["<YYYY-MM-DD>"] }` (skip_dates takes ISO-8601 calendar dates, e.g. public holidays).
- "Trigger-bound webhook rejects real events?" → the bind wrote a placeholder secret; rotate the real signing secret onto the binding.


# Transactional email from a signed input

`transactional_delivery` is an explicit Gmail execution-authority profile for one
reply per unique request to the email in a reviewed original input path. Its
`webhook_id` must identify an active same-tenant, same-workflow Standard Webhooks
binding with exactly its reviewed `event_type`; skip verification is refused.
The trusted webhook admission stores verified source provenance independently of
visitor input. An authenticated on-demand invocation that merely labels its
input as a webhook cannot use this profile. The existing fixed `gmail_report`
profile is unchanged.

`outbox_delivery` is the scheduled counterpart without a webhook: one email per
queued message to the recipient an earlier fixed read-only GET step returned in
the same run, one attempt per queue entry, capped by `max_per_day`.

Standard Webhooks signs `webhook-id.webhook-timestamp.rawBody` using its dedicated
secret. The existing five-minute timestamp window and event filter apply. Replays
with identical stable input reuse the admitted execution; changed content under
the same signed event ID is refused. Persist the original request ID and payload
before handoff. Renew the timestamp and signature when retrying, not the payload.
No API credential belongs in a public form or browser bundle.

The transactional mail receipt survives retries and version changes. Reservation
precedes network access and prevents a second dispatch attempt, including after a
crash with unknown delivery. Result states `attempted`, `sent` and
`delivery_unknown` are operational evidence, not proof of inbox delivery.

A signed ingress does not approve effects. The operator reviews the exact workflow,
connection, sender, recipient field, event source and request-size ceiling, plus
normal run/time limits. Revocation and inactive bindings are rechecked before
external dispatch. This feature does not authorize sending to arbitrary recipient
lists, add CC/BCC, or bypass sensitive execution restrictions.

For transactional mail, also declare `event_type_input`, a reviewed dot path in
`body` whose signed value equals `event_type`. The `webhook-type` header itself is
not covered by the Standard Webhooks signature; matching only that header is
insufficient. Use `execution_privacy: sensitive`. Inspect persistent outcomes with
`GET /v1/workflows/{id}/transactional-mail-receipts` under `workflow:read`; this
endpoint includes no email address or message body and cannot trigger delivery.

`get_workflow` includes the newest durable mail receipts for transactional email
workflows; inspect these before diagnosing handoff or suggesting any resend.

Signer interoperability: SubKit uses the stored secret string verbatim as UTF-8
HMAC-SHA256 key, signs `id.timestamp.rawBody` and sends `v1,<Base64-HMAC>`. It does
not strip or Base64-decode a `whsec_` prefix. Match the same bytes in a server
adapter; never paste the secret into a conversation or browser bundle.
