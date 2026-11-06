---
slug: gmail-report-automation
scope: connector
title: Gmail Report Automation
description: How a Gmail report step must be shaped so its repeated runs can be reviewed — fixed sender and recipient, an object body with raw as the only property, and UTF-8 MIME built with the sk helpers.
activates_when: [{"kind":"connector_template","slug":"google-gmail"}]
side_effects: read
idempotency: none
maturity: stable
tags: [connector, gmail, report-delivery, automation]
version: 1
---

# Gmail Report Automation

For Gmail reports, a fixed sender and recipient with a changing UTF-8 subject and body can be reviewed for repeated runs. The saved-change review dialog prepares a held preview automatically, so the person reviewing sees the real sender, recipient and content type before granting recurring permission.

## Message shape the review accepts

- The supported Gmail request body must be an object with `raw` as the only property, not a whole-body substitution. Keep the literal object in the step and substitute only the `raw` value.
- The MIME message must include explicit `From`, `To`, `Subject`, `MIME-Version` and a `text/plain` or `text/html` `Content-Type`.
- Preserve the sender and recipient. Changing either one changes the reviewed boundary and needs a new review.

## Building the message

When authoring Unicode report MIME, use `sk.base64UrlEncodeUtf8`, not the binary-string `sk.base64UrlEncode`. `sk.buildMimeMessage({ from, to, subject, html?, text? })` already returns the encoded single-part message in `raw` and encodes non-ASCII headers correctly; prefer it over hand-assembled MIME.

```json
{
  "id": "send",
  "kind": "request",
  "connector_id": "<gmail_connector_id>",
  "method": "POST",
  "path": "/users/me/messages/send",
  "body": { "raw": "${scope.build.data.raw}" }
}
```

The `build` transform returns `sk.buildMimeMessage(...)` with the fixed sender and recipient and the changing subject and body. Save the change, then review the automation again; never assume an edit fixed eligibility.
