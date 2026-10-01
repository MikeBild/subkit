---
slug: governed-delivery
scope: global
title: Governed Report Delivery
description: Why a report e-mail step is refused by the execution gate, the exact message shape the report profile accepts, and how to repair it — prepare or declare, never `boundary`, never another mail provider.
activates_when: [{"kind":"diagnosis","codes":["report_delivery_unprepared","report_delivery_unobserved","report_delivery_unreachable","report_delivery_contradicted","not_json_raw","not_base64url","not_utf8","header_control_byte","header_folded","header_not_allowed","header_duplicate","missing_headers","sender_invalid","recipient_invalid","extra_recipients","multipart_unsupported","content_type_unsupported","transfer_encoding_unsupported","body_not_base64","recipient_differs","sender_differs","content_type_differs"]},{"kind":"tool","tool":"diagnose_workflow"},{"kind":"tool","tool":"propose_workflow_repair"}]
side_effects: read
idempotency: none
maturity: stable
tags: [authoring, governance, report-delivery, repair]
version: 1
---

# Governed Report Delivery

A workflow that e-mails a report runs unattended only after a human granted it
a finite execution authority. The authority binds every write the workflow can
make. A mail-send step has a body that changes with every run, so a fixed
target is not enough to review it: the engine reviews **who receives the
message, who sends it and in which format** instead. That reviewed statement is
the step's `report_delivery` boundary.

## How the boundary comes to exist

- **Prepare (the normal path).** A preparation is a held run: it resolves every
  step's real target and content and sends nothing. For the send step it decodes
  the message it would have sent and records sender, recipient and content type.
  That observation becomes the boundary a human then approves.
- **Declare (only when preparing cannot reach the step).** When the step sits
  behind a condition that depends on a write a held run suppresses, no
  preparation can ever observe it. Then the step states the boundary itself:
  `report_delivery: {kind: "gmail_report", to, from, content_type}`. A human
  approves that statement, and at dispatch the runtime still decodes the real
  message and compares it, so a declaration that does not match is refused
  before anything leaves. Never declare a step a preparation can observe.

A hook-started workflow needs a delivery to prepare over. The reviewer's sample
wins; without one the newest admitted delivery is used, and only when there is
none does the preparation ask for a sample (`input_required`).

## The message the profile accepts

The runtime reads the step's body `{ "raw": "<base64url RFC 822 message>" }`
and refuses anything it cannot read exactly:

- **One recipient** in `To`. No `Cc`, `Bcc`, `Reply-To` or custom headers —
  only `From`, `To`, `Subject`, `MIME-Version: 1.0`, `Content-Type` and
  `Content-Transfer-Encoding` (`7bit`, `8bit` or `base64`), each once, unfolded.
- **Display names are allowed** (`Reports <reports@example.com>`); sender and
  recipient are compared by address. A name is plain ASCII words and spaces —
  no quotes, parentheses, `:` `;` `@` `,` `.` or other address punctuation; a
  quoted name or a comment is refused, not parsed.
  Never put a second address in `To`: that is `extra_recipients`.
- **Content**: a single `text/plain` or `text/html` body, or one
  `multipart/alternative` with exactly two parts, `text/plain` then
  `text/html`. No attachments, no nested multiparts.
- **UTF-8 throughout.** Build the message with `sk.buildMimeMessage({ from, to,
  subject, text?, html? })`, which encodes headers and bodies correctly, or
  encode a hand-built message with `sk.base64UrlEncodeUtf8(mime)`. Never
  `sk.base64UrlEncode`: it writes one byte per character, so "—" or "·"
  becomes invalid UTF-8 and the gate refuses with `not_utf8` or
  `header_control_byte`.

## What is never the fix

- **`boundary` on the send step.** `boundary` bounds a generic HTTP request. A
  report e-mail has its own, stricter review; adding `boundary` neither makes
  the profile read the message nor replaces the recipient review.
- **Switching the mail provider.** The report profile exists for the reviewed
  send target. Another provider turns the step into an unbounded write that
  needs a review of every single run — the workflow stops being automatable,
  it does not become more so.
- **Removing the recipient from review**, widening it to a list, or moving it
  into an input the delivery controls.

## Reading a diagnosis

| Code | Meaning | Repair |
| --- | --- | --- |
| `report_delivery_unprepared` | No preparation exists for this version and environment. | Prepare once; nothing is sent. |
| `report_delivery_unobserved` | A preparation reached the step but the message was unreadable (unresolved placeholder, extra header, second recipient, wrong encoding). | Fix how the message is built, then prepare again. |
| `report_delivery_unreachable` | A preparation exists but never reached the step. | Make the branch reachable without the held write, or declare `report_delivery`. |
| `report_delivery_contradicted` | The step declares `report_delivery`, and a preparation of this version reached it with a message outside the profile or addressed differently. | Fix the message so it matches the declaration; never widen the declaration to the message. |
| `execution_authority_changed` | An approved run was refused at dispatch. The step error's `reason` names the rule: a profile refusal such as `not_utf8` or `extra_recipients`, or `recipient_differs` / `sender_differs` / `content_type_differs`. | `not_utf8` and `header_control_byte` come from a one-byte-per-character encoder: switch to `sk.base64UrlEncodeUtf8` or `sk.buildMimeMessage`. |

## Tools

Use `diagnose_workflow` to read why the gate holds a workflow: per refused step
it returns the gate code, the report gate's own `reason` when it named one
(for example `not_utf8`), what kind of act removes the block (`patch`,
`prepare`, `declare`, `reconnect`, `author`), a `fixer` when a deterministic
repair exists, and `candidate_id` when that repair already waits for review.
Use `propose_workflow_repair` with the step and fixer to file that repair as a
proposed patch candidate — a proposal a person approves, never an applied
change; calling it again returns the same candidate. After a repair lands,
prepare again: a new version has no observation of its own.
