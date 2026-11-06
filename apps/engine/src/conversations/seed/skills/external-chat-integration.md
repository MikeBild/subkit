---
slug: external-chat-integration
scope: global
title: External Chat Integration
description: Mental model for bringing sk into Slack and Google Chat (Microsoft Teams is not supported yet) — the same governed Conversation authoring loop, rendered as native platform messages. Exhaustive setup, route, and identity-linking facts live in the sk-ref-chat knowledge source; fetch them with search_knowledge.
activates_when: [{"kind":"intent_keyword","word":"slack"},{"kind":"intent_keyword","word":"teams"},{"kind":"intent_keyword","word":"google chat"},{"kind":"intent_keyword","word":"chat"}]
side_effects: read
idempotency: none
maturity: stable
tags: [chat, integration, sk-platform-reference]
version: 2
---

# Bringing sk into Slack and Google Chat

Mental model: each chat platform gets a dedicated adapter that normalises
incoming messages — mentions, slash commands, interaction callbacks — into sk's
Conversation model. The *same* AI authoring loop that runs in the sk CLI runs
inside the thread, rendered as native platform messages. Chat is a door onto the
one governed engine: same RBAC, same Audit Log, same identity envelope. It is
not a second authoring stack.

## Key facts

- **Two supported platforms.** The platform tag is `slack` or `google_chat`.
  Each owns ingress routes under `/v1/chat/<platform>/...`
  (e.g. `/v1/chat/slack/events`, `/v1/chat/slack/interactions`,
  `/v1/chat/slack/slash`, `/v1/chat/google/events`).
  Every request that lands under `/v1/chat` carries request source `chat` in the
  identity envelope and Audit Log.
- **Microsoft Teams is not supported yet.** The `teams` enum value exists, but
  no adapter does: installing a Teams workspace is refused with
  `platform_unsupported`. Say so plainly and do not walk anyone through a
  Teams setup.
- **Identity linking is mandatory.** A platform identity (Slack user ID or Google
  Chat identity) must be linked to an sk account before
  messages carry a role and permissions. Unlinked senders are rejected, not
  silently run. Workspaces are installed via `/v1/chat/workspaces`; identities
  are managed via `/v1/chat/identities` (admin routes).
- **Conversations persist across days.** A thread started today and continued
  tomorrow resumes exactly where it left off — it maps to a durable sk
  Conversation, the same one the underscore tools `conversation_start`,
  `conversation_append`, `conversation_get`, and `conversation_commit` drive.
- **Approvals are in-thread.** When a Draft or Patch Candidate needs sign-off,
  the adapter renders a native interactive card. Elicitation kinds are
  `confirm`, `choice`, `multi`, `text`, and `form`; the decision is recorded in
  the Audit Log with `chat` as the request source.
- **Slash verbs are `chat`, `run`, `help`.** `chat` opens/continues authoring,
  `run` invokes a committed workflow with args, `help` returns guidance.
- **Notifications route through Notification Rules** by event, severity, and
  quiet hours. Chat is sk's primary notification channel; email notifications
  are not supported.
- **The chat palette is read-only, and that excludes remote MCP tools.** A
  tenant's external MCP servers are connectors with `driver: "mcp"`, and their
  remote tools (`mcp_<connector_slug>__<remote_tool>`) are merged into the
  palette on authoring surfaces only — never on Slack or Google Chat,
  the same posture as `call_connector`. On this channel, explain what the
  connector does and point the operator at the `sk` CLI or the web portal;
  do not offer to call a remote MCP tool you cannot reach.

## Get the full reference before you act

This skill is intentionally thin. For exact install steps, signature-
verification requirements per platform, the workspace/identity request and
response shapes, and the slash-command grammar, call:

```
search_knowledge({ query: "<your question>", tags: ["sk-platform-reference"] })
```

The exhaustive content lives in
the knowledge source slug `sk-ref-chat`. Do not reconstruct route paths, payload
shapes, or setup steps from memory — fetch the reference and quote it.
