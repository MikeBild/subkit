---
slug: workflow-authoring-transactional-mail
scope: global
title: Transactional Replies To Signed Requests
description: The `transactional_delivery` and `outbox_delivery` Gmail profiles: one reviewed email per verified signed request or per queued message read from a fixed address, their declarations, receipts and limits.
activates_when: [{"kind":"intent_keyword","word":"transactional"},{"kind":"intent_keyword","word":"transaktional"},{"kind":"intent_keyword","word":"transactional_delivery"},{"kind":"intent_keyword","word":"gmail_transactional"},{"kind":"intent_keyword","word":"signed request"},{"kind":"intent_keyword","word":"signierte anfrage"},{"kind":"intent_keyword","word":"confirmation email"},{"kind":"intent_keyword","word":"bestätigungsmail"},{"kind":"intent_keyword","word":"webhook-id"},{"kind":"intent_keyword","word":"outbox"},{"kind":"intent_keyword","word":"outbox_delivery"},{"kind":"intent_keyword","word":"gmail_outbox"},{"kind":"intent_keyword","word":"warteschlange"},{"kind":"diagnosis","codes":["report_delivery_unreachable","report_delivery_unobserved"]}]
side_effects: read
idempotency: none
maturity: stable
tags: [authoring, workflow, email, webhook]
version: 2
---

# Transactional Replies To Signed Requests

## Transactional replies to signed requests

Use `transactional_delivery` on a Gmail request step when one email must be sent
to a different applicant on each verified incoming request. This is a separate
profile from `report_delivery`, whose recipient remains fixed. Never keep a fixed
report recipient as an audit placeholder while sending a different MIME recipient.
Generic HTTP `boundary` cannot replace either Gmail profile.

The declaration is `{kind: "gmail_transactional", webhook_id, event_type, event_type_input,
recipient_input, request_id_input, from, content_type: "text/plain", max_body_bytes}`.
All input paths are reviewed dot paths beginning with `body.`, such as
`body.registration.email` and `body.registration.id`; the UUID must equal the
signed `webhook-id`. Fields and event types are application-defined, not tied to
any product. For a body-bound HMAC source, additionally declare
`webhook_verifier: "hmac"`. Its active binding must subscribe to exactly the
reviewed event type, sign `v1:{timestamp}:{body}` with a timestamp window of at
most 300 seconds, and derive both event ID and type from the signed body. The
reviewed `request_id_input` and `event_type_input` must match those exact fields;
an unsigned ID or type header cannot substitute for them. A bounded non-UUID
signed request ID receives a deterministic opaque receipt UUID, so retries and
new execution IDs cannot reserve a second mail attempt for that workflow.
For a Stripe-signed trigger (`verify: "stripe-signature"`), declare
`webhook_verifier: "stripe"` with `request_id_input: "body.id"` and
`event_type_input: "body.type"`; the binding must subscribe to exactly the reviewed
event type, and the signed Stripe event ID gets the same opaque receipt UUID.
Omitting `webhook_verifier` retains the Standard Webhooks UUID contract.
Use `max_retries: 0`, a single POST to the Gmail send endpoint with
only `{raw}`, no pagination, fan-out or read-effect override. Bound template inputs
and derive the declared request-size ceiling from them. The workflow input schema
must strictly validate its business fields. The runtime compares actual decoded
MIME sender, sole recipient and format to the reviewed profile and original
admitted input. CC/BCC and recipient overrides are refused.

Provision the actual Standard Webhooks, body-bound HMAC or Stripe binding securely, with its
own secret, same tenant/workflow and exactly the reviewed event type. Never use
`verify: "none"`, never expose a signing key in browser code, and never fabricate
a signed event or execution caller in a preview. A signature authenticates an
incoming request; it does not grant execution authority. Prepare the exact saved
version and show the normal human boundary/limits review before activation. With
sensitive execution, use the metadata-only `dry_run_workflow` test run, or its
`schema_only` check when that run is refused, and never force-save around missing
evidence. Fresh inspection, successful schema validation and a green metadata test
run or passed `schema_only` check allow saving only an inactive immutable draft under
the normal save approval policy. This does not activate the workflow or grant runs;
live verification uses the permitted execution/result API separately.

Separately managed signed bindings are independent of the workflow definition's
request, schedule or webhook trigger. After activation, inspect the actual binding
again before enabling a form. A missing binding stops commissioning. Recreate it
through normal binding management and prepare a new reviewed version referencing
the actual new ID; never fabricate the removed ID or bypass signature checks.

A persistent per-workflow/request receipt reserves one dispatch attempt before
network access. An uncertain result or crash after reservation must not be retried
automatically, even by rerunning the workflow or changing versions. Inspect the
receipt and execution first. `sent` means the remote API accepted the request, not
that the message reached an inbox. Normal form receipt and webhook acceptance are
separate from mail outcome. Update website copy to match what is actually enabled.

For transactional mail, also declare `event_type_input`, a reviewed dot path in
`body` whose signed value equals `event_type`. The `webhook-type` header itself is
not covered by the Standard Webhooks signature; matching only that header is
insufficient. Use `execution_privacy: sensitive`. Inspect persistent outcomes with
`GET /v1/workflows/{id}/transactional-mail-receipts` under `workflow:read`; this
endpoint includes no email address or message body and cannot trigger delivery.

`get_workflow` includes the newest durable mail receipts for transactional email
workflows; inspect these before diagnosing handoff or suggesting any resend.

## Messages from a queue

`outbox_delivery` (`kind: "gmail_outbox"`) mails one recipient per run, taken from
the response of an earlier fixed read-only GET (`source_step_id`). Whoever fills
that queue chooses the recipients; say so.
