# Notifications

A workflow run is only useful if the people who care about it find out
when it finishes — succeeded, failed, or aborted. The notifications
subsystem turns engine outbox events into delivered messages, governed
by tenant-scoped rules, with rate limits, circuit breakers, audit, and
RBAC.

## Surface at a glance

| Concept | Where it lives | What it does |
|---|---|---|
| Notification rule | `notification_rules` row | Selects which events go where, with severity + filter |
| Notification channel | `notification_channels` row | Concrete delivery target — Slack workspace+channel, Teams team+channel, Google Chat space, or webhook URL |
| Notification delivery | `notification_deliveries` row | Per-attempt result: `sent`, `rate_limited`, `breaker_open`, `failed`, `skipped` |
| Adapter | `chat/{slack,teams,google_chat}/adapter.ts` + `notifications/channels/webhook.ts` | Talks to the platform |
| Dispatcher | `apps/engine/src/notifications/service.ts` | Matches rules → applies rate limit + breaker → invokes adapter → records audit + delivery row |
| Outbox fanout | `apps/engine/src/webhooks/outbound/fanout.ts` | Drains `events` table → calls `dispatchEvent()` |

## End-to-end flow

1. A workflow finishes. `apps/engine/src/execution/state.ts` writes an
   `events` row with channel `execution.status` and type
   `execution.<status>` (`succeeded`, `failed`, `aborted`,
   `timed_out`, ...).
2. The outbox listener picks the row up and forwards it to
   `webhooks/outbound/fanout.ts`. The fanout looks up active
   subscriptions (for outbound webhooks) AND active notification rules
   (for chat / webhook notifications).
3. For each matching rule, `notifications/service.ts#dispatchEvent`:
   1. resolves (or auto-creates) the `notification_channels` row,
   2. checks the circuit breaker (`closed` → continue, `open` →
      record `breaker_open` and skip, `half-open` → trial-fire),
   3. acquires a token from the leaky-bucket rate limiter (records
      `rate_limited` when the bucket is empty),
   4. resolves an adapter via the registry,
   5. invokes `adapter.send()` with a structured `ChatDelivery`,
   6. records a `notification_deliveries` row + an audit row,
   7. updates the breaker state from the outcome
      (`closed → open` after `FAILURE_THRESHOLD` consecutive failures;
      `half-open → closed` on first success).

The dispatcher always resolves — per-rule failures are logged and
recorded, never thrown. A misconfigured rule cannot block other
deliveries.

## Channels

### Chat (Slack, Teams, Google Chat)

The chat adapters under `apps/engine/src/chat/` ship as full peers —
they verify inbound webhooks, normalize platform events, and post
outbound messages. The notification subsystem reuses the same
`send()` surface to deliver completion signals to the operator's
chat workspace.

### Webhook (`notifications/channels/webhook.ts`)

For tenants that prefer a generic HTTP endpoint over a chat platform.
The adapter:

- POSTs JSON `{ tenant_id, workspace_id, channel_id, kind, text }`
  with headers `content-type: application/json`,
  `x-subkit-notification: 1`, `x-subkit-attempt: <n>`, and an
  optional `x-subkit-secret` shared secret.
- Bounded retry: at most `WEBHOOK_MAX_ATTEMPTS` tries (default 3),
  exponential backoff capped at `WEBHOOK_BACKOFF_CAP_MS` (30 s).
- Honours `Retry-After` on `429`/`503` responses.
- Treats non-`429` `4xx` responses as terminal — retrying a
  mis-configured receiver wastes budget.

## Rules

A `notification_rules` row carries:

- `event_pattern` — glob matched against the event type
  (`execution.*`, `execution.failed`, `*`).
- `workflow_pattern` — glob matched against `workflow_id` or
  `workflow_slug` so a rule can scope to a specific workflow
  family.
- `severity` — drives both the platform-side rendering and the
  per-rule rate limit.
- `request_source_filter` — array of sources the rule should fire
  for. Default semantics in the dispatcher skip notifications for
  `chat`-sourced runs (the conversation already saw the result) and
  `mcp` runs (the caller is an LLM, not a human).
- `target_workspace_id` + `target_channel_id` — point at the
  channel row to deliver through.
- `active` — soft-disable without deleting.

## Rate limiting

Per-channel leaky bucket in
`apps/engine/src/notifications/rate-limit.ts`. Tokens regenerate at
`rate_limit_per_minute / 60 000` ms. When the bucket is empty the
dispatcher records `rate_limited` with the resume time and skips
delivery — the rule's downstream consumer is not stalled by the
limiter.

## Circuit breaker

Per-channel three-state breaker in
`apps/engine/src/notifications/circuit-breaker.ts`:

| State | Effect |
|---|---|
| `closed` | Deliveries proceed. Failure count resets on success. |
| `open` | Dispatcher records `breaker_open` and skips. Auto-flips to half-open after `OPEN_DURATION_MS`. |
| `half-open` | One trial delivery is allowed. Success → `closed`; failure → `open`. |

Threshold: `FAILURE_THRESHOLD` consecutive failures (default 5)
opens the breaker. The breaker is per-channel, not per-rule, so a
rule that targets a healthy channel keeps firing even when an
unrelated rule's target is down.

## RBAC

| Permission | Routes / actions |
|---|---|
| `notification:read` | List/get channels, rules, deliveries; `GET` on every notifications endpoint. |
| `notification:write` | Create/update/delete channels and rules; `POST /v1/notifications/rules/:id/test` (because triggering a synthetic event causes a real outbound delivery and a real audit row). |

Every write through the HTTP routes flows through `auditAwait` so the
audit log carries the actor, the resource, and the changed fields.

## HTTP routes

- `GET    /v1/notifications/channels`
- `POST   /v1/notifications/channels`
- `PATCH  /v1/notifications/channels/:id`
- `DELETE /v1/notifications/channels/:id`
- `GET    /v1/notifications/rules`
- `POST   /v1/notifications/rules`
- `PATCH  /v1/notifications/rules/:id`
- `DELETE /v1/notifications/rules/:id`
- `POST   /v1/notifications/rules/:id/test` — synthesise a
  notification event and dispatch it through the rule pipeline.
  Returns the rule-matching, rate-limit, and channel-dispatch outcome
  so operators can verify a rule end-to-end without waiting for a
  real workflow run. Audited as `notification_rule.tested`.
- `GET    /v1/notifications/deliveries?limit=&offset=&status=`

All routes are Zod-first (see `apps/engine/src/http/routes/notifications.ts`)
and surface in the generated OpenAPI document.

## Audit actions

- `notification_channel.created` / `.updated` / `.deleted`
- `notification_rule.created` / `.updated` / `.deleted` / `.tested`
- `chat.message.sent` (delivery `sent`)
- `chat.message.denied` (delivery `rate_limited` or `breaker_open`)
- `webhook.outbound.failed` (delivery `failed`)

## Observability

- Counter `chat_delivery_total{platform,status}` —
  partitioned by adapter platform and outcome.
- Counter `webhook_delivery_total{subscription_id,status}` —
  for the webhook subscriptions surface (parallel system; see
  `docs/operations.md`).
- Structured logs from `notifications/service.ts` carry
  `tenant_id`, `rule_id`, `channel_id`, `event_type`, `status`.

## What is intentionally not here

- **Per-user notifications** — recipients are channel-targeted; we
  do not maintain a personal-inbox model.
- **Templating DSL** — the rendered message text is built from the
  event metadata. A future template field on rules could land here
  without changing the dispatch contract.
- **In-app notification surface** — there is no dedicated UI inbox;
  the deliveries table is the authoritative log.

## Notification payload pattern — what, why, proposal

Notifications are the first place an operator sees the bounded
repair loop in action. The conceptual job of a useful incident
message is to answer four questions in a single delivery, so the
operator can decide without opening logs:

1. **What** happened — the failure substance (status, surfaced
   error, timestamp).
2. **Where** in the operational system it happened — workflow slug
   and version, step id, the external endpoint that drifted.
   Important the moment there is more than one workflow, more than
   one supplier, more than one tenant: "the script broke" is not
   enough.
3. **Why** it happened — the drift the connector or driver actually
   detected, not just the HTTP status, plus the `patch_candidate`
   reference when the bounded repair loop has already produced one.
4. **How** to act — the Patch Candidate diff, the deterministic
   dry-run outcome against recorded fixtures, and the operator
   actions: **approve**, **reject**, **escalate to human**.

A concrete delivery body — the same shape across every surface:

```json
{
  "what": {
    "occurred_at": "2026-05-27T14:02:11Z",
    "status": "failed",
    "error": "http_422 — unknown field 'sku_external'"
  },
  "where": {
    "workflow_slug": "sync-suppliers",
    "workflow_version": 4,
    "step_id": "pull-supplier-3",
    "endpoint": "supplier-3/inventory"
  },
  "why": {
    "kind": "schema_drift",
    "diff": { "renamed": [{ "from": "sku_external", "to": "sku" }] },
    "patch_candidate_id": "pc_4711"
  },
  "how": {
    "summary": "Map field 'sku_external' → 'sku' in pull-supplier-3 response shape",
    "dryrun": { "fixtures": 12, "passed": 12, "diverged": 0 },
    "actions": ["approve", "reject", "escalate"]
  }
}
```

The Slack / Teams / Google-Chat adapters render the same payload
into a platform-native block layout with the four sections as
headings and the operator actions as buttons. The webhook channel
forwards the JSON verbatim — the receiving operator system gets the
same four-part answer it could surface in its own UI. The **sk CLI**
renders the same four-part shape into terminal-native blocks via
`sk executions tail` (live *what* + *where* + *why* as the run
progresses) and `sk patch-candidates get <id>` (the *how* with `sk
patch-candidates approve` / `reject` as the actions). The CLI is a
pull surface, the chat / webhook adapters are push surfaces — the
**payload contract is the same** across all of them, so every
operator path lands on the same answer.

The point is not the wire format and not the surface. The point is
the conceptual job: the closed learning loop is only as good as the
moment in which a human can act on it, and acting requires *what*,
*where*, *why*, and *how* in one place. The alternative — a red
workflow plus a "go read the logs" link — pushes the operator into
reconstructing all four questions from scratch, which is where the
compounding loop quietly stalls into a ticket backlog.
