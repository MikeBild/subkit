---
slug: transactional-email-replies
summary: Let a workflow reply by email to the sender of a signed request.
section: work
order: 8
audience: public
---
## Transactional email replies

A Gmail request step may use the explicit `transactional_delivery` profile to
reply to the address in an original signed request. This is reusable for access
requests, registrations and other requested replies. Event names and field paths
are configurable; no website, product or applicant is built into the engine.
Fixed-recipient `report_delivery` continues to use its existing rules.

### Author the workflow

Use sensitive execution privacy, a strict input schema with bounded lengths and
one plain-text Gmail send step. Keep sender, connection and template in the
reviewed workflow; visitor input selects only the reviewed original recipient.
The payload must include its UUID and event type inside the signed JSON body.
For example, an event body with `event`, `reference` and `contact.address` can use:

```json
{
  "kind": "gmail_transactional",
  "webhook_id": "<reviewed-binding-uuid>",
  "event_type": "registration.requested",
  "event_type_input": "body.event",
  "request_id_input": "body.reference",
  "recipient_input": "body.contact.address",
  "from": "sender@example.test",
  "content_type": "text/plain",
  "max_body_bytes": 8192
}
```

Place the profile on the Gmail request step beside `max_retries: 0`. Its request
body must contain only `raw`. No pagination, fan-out, generic boundary, simultaneous
fixed-recipient profile, response selection or filtering is supported. Input paths
start at `body`, traverse own object properties and reject prototype keys. Choose
a request-byte ceiling from the bounded template, rather than the largest allowed
value. The ceiling measures serialized UTF-8 Gmail JSON, including base64 overhead.

### Bind and review

1. Create an active Standard Webhooks binding for this workflow in the same tenant.
   Configure exactly the reviewed event type and a dedicated signing secret. Never
   use skipped verification, a public API key or browser credentials.
2. Persist the request UUID and original payload before handoff. Send the UUID in
   both the signed body and `webhook-id`. Sign `id.timestamp.rawBody` and send the
   matching timestamp, signature and event-type headers. The event type also has
   to match the reviewed field inside the signed body: the header alone is unsigned.
3. Prepare and validate the workflow normally. The operator reviews the exact
   version, sender, connection, signed source and field paths, byte ceiling and
   run/time limits. A signature authenticates ingress; it does not grant effects.
   Do not force a sensitive workflow through a missing preparation or approve a
   static report recipient while actually addressing somebody else.
4. Activate only after those checks and the normal human execution-authority
   review. Confirm behavior with a controlled recipient, then connect the public
   form and verify the same request twice produces one message.

Separately managed inbound bindings remain independent of the definition's
trigger. Request or schedule activation removes only reverse-bound webhook
triggers; webhook activation updates only its own reverse-bound binding. It
never rewrites or removes CRUD bindings, their signing secrets or event filters.
Archiving or deleting a workflow still removes all its inbound bindings. After
activation, verify that the reviewed signed source is still present before
enabling a public form. A removed source requires a new binding and a normally
reviewed workflow version referencing its actual ID; never reuse a stale ID or
weaken signature verification.

At dispatch the engine rechecks authority, source provenance, active binding,
original input identity, actual MIME recipient/sender/type and request size. A
payload field pretending to be provenance is ignored. On-demand calls, child
workflows and concrete one-off tool approvals cannot substitute for the signed
admission and reviewed recurring authority. CC/BCC and extra recipient headers
are rejected. The outgoing request cannot follow redirects or retry automatically.

SubKit's existing signer uses the stored secret string verbatim as a UTF-8 HMAC
key. Compute HMAC-SHA256 over `id.timestamp.rawBody`, Base64-encode the result and
send `webhook-signature: v1,<base64>`. There is no automatic `whsec_` prefix removal
or Base64 key decoding. Match those exact key bytes in an external adapter; a
library's protocol name alone does not guarantee interoperability.

### Inspect outcomes

`GET /v1/workflows/{id}/transactional-mail-receipts?limit=20&offset=0` requires
`workflow:read` for that workflow. It returns request/execution/step IDs, state and
timestamps, with no applicant address or MIME. The public OpenAPI contract includes
this read operation. Audit also records reservation and settlement.

A reservation is written atomically before network access. Its unique key is the
tenant, workflow and original request UUID, across workflow versions and execution
IDs. It survives execution cleanup; workflow or tenant deletion removes it.
`sent` requires a successful Gmail response with a message ID and confirms API
acceptance, not inbox delivery. `attempted` and `delivery_unknown` require operator
inspection. A crash, timeout or ambiguous response never authorizes automatic
resend. This endpoint has no retry or reset operation. Producer handoff retries
keep exactly the same payload and ID, renewing only timestamp/signature; changed
content under a previously admitted signed ID is refused.

### Model and authoring behavior

The shipped workflow-authoring skill and webhook knowledge explain this profile,
its limits and refusal remedies. The generated agent documentation and OpenAPI
schemas describe the same contract. Confirmation of tenant knowledge remains a
human review step; source changes do not silently approve tenant material.
Tool palettes, including MCP workflow aliases, validate object schemas before invoking a provider. Incompatible
root combinators/references are omitted without weakening workflow validation;
use the generic workflow operation. Residual schema errors are classified as
schema incompatibility, not network/provider unavailability.

