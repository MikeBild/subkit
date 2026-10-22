---
slug: transactional-email-replies
summary: Let a workflow reply by email to the sender of a signed request.
section: work
order: 8
audience: public
---
## Reply by email to a signed request

A workflow can send one plain-text Gmail reply to the person who submitted a form, for example an access request.
The reply goes only to the address in the original signed request.
You review sender, template and limits before anything is sent.

The path is always the same: **signed request → reviewed workflow → approval → one reply**.

### What you need

- A Gmail connection (connector) in your workspace.
- A signed source that sends requests in the Standard Webhooks format.
- A person who approves the workflow.
- An operator who reviews the workflow before activation.

Never skip signature verification, and never use a public API key or browser credentials for the source.

### Set up the workflow

1. Set `execution_privacy: sensitive` and a strict input schema with bounded lengths.
2. Add exactly one plain-text Gmail send step. Its request body contains only `raw`.
3. Keep sender, connection and template in the workflow. The request selects only the reviewed original recipient.
4. On the Gmail request step, add the `transactional_delivery` profile and `max_retries: 0`.
5. Set `max_body_bytes` from the bounded template, not the largest allowed value.

The signed JSON body must contain the request UUID and the event type. Input paths start at `body`. For a body with `event`, `reference` and `contact.address`, the profile looks like this:

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

`max_body_bytes` counts the serialized Gmail JSON, including the base64 overhead. Pagination, fan-out, a second fixed-recipient profile and response filtering are not supported in this step.

You can also describe this workflow in the Cockpit chat. The chat knows this profile and its limits.

### Bind and review

1. In the same workspace, create an active Standard Webhooks binding for the workflow. Use exactly the reviewed event type and its own signing secret.
2. In the source, save the request UUID and the original payload before sending.
3. Send the UUID in the signed body and in `webhook-id`.
4. Ask an operator to review version, sender, connection, signed source, field paths, byte limit and run limits.
5. Activate the workflow and approve it.

### Test the reply

1. Send a test request to a controlled recipient.
2. Check that the signed source still exists after activation.
3. Connect the public form.
4. Send the same request twice and check that one message arrives.

### Compute the signature

Use the secret string verbatim as the UTF-8 HMAC key. SubKit does not strip a `whsec_` prefix and does not Base64-decode the key.

1. Compute HMAC-SHA256 over `id.timestamp.rawBody`.
2. Base64-encode the result.
3. Send `webhook-signature: v1,<base64>`.

Also send matching timestamp and event-type headers. The header alone is unsigned, so the event type must also match the reviewed field in the signed body.

### What happens next

Before sending, the engine checks the approval, the signed source and the recipient again. CC, BCC and extra recipients are refused.

Good to know:

- A failed or unclear send is never resent automatically. There is no retry or reset operation.
- Each original request gets at most one reply, across workflow versions and runs.
- A signature only authenticates the request. Only the approval allows the workflow to send.
- A retried handoff keeps the same payload and ID and renews only timestamp and signature. Changed content under the same ID is refused.

### Inspect outcomes

`GET /v1/workflows/{id}/transactional-mail-receipts?limit=20&offset=0` requires `workflow:read` for that workflow.

It returns:

- Request, run and step IDs
- State and timestamps

It does not return the applicant's address or the message content.

The audit records each reservation and its result.

| State | Meaning |
| --- | --- |
| `sent` | Gmail answered with a message ID. This confirms that Gmail accepted it, not that it reached the inbox. |
| `attempted`, `delivery_unknown` | The operator inspects the case. |

### If something does not work

| What you see | What to do |
| --- | --- |
| The state is `attempted` or `delivery_unknown` | The operator inspects the case. There is no automatic resend and no reset endpoint. |
| A request is refused although the signature is correct | Check that the event type in the signed body matches the header and the reviewed field path, and that the UUID in the body and in `webhook-id` agree. |
| A repeated handoff is refused | The content under that signed ID changed. Send the same payload and ID again and renew only timestamp and signature. |
| Sending is refused because of recipient headers | Remove CC, BCC and extra recipient headers. Only the reviewed original recipient is allowed. |
| The signed source is gone after activation | Create a new binding and activate a reviewed workflow version that references its actual ID. |
