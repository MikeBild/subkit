# 14 — Chat Platforms

Chat platforms are not just notification sinks. They are **first-class end-user interfaces** for the engine, equivalent in capability to the CLI. A human can start or resume a Conversation inside a chat thread, run Workflows, browse Skills, approve sensitive tool calls, tail Executions, and receive severity-routed alerts — all without leaving the platform. **Email is explicitly out of scope as a notification channel.** A tenant who needs email delivery can build an Email Connector and drive it from a Workflow.

This file specifies the Chat Adapter interface, the per-platform implementations for Slack, Microsoft Teams, and Google Chat, the progressive-edit streaming strategy, the human-in-the-loop approval flow, the slash-command grammar, the Notification Rule integration, and the rate-limit and circuit-breaker model.

## The Chat Adapter interface

Every chat platform integration implements one TypeScript contract. Adapters share the engine-side machinery (Conversation, Policy, Context Enhancement, Tool Loop) and differ only in transport and payload shapes.

```ts
export interface ChatAdapter {
  readonly platform: "slack" | "teams" | "google_chat";
  receive(req: HttpRequest): Promise<ChatEvent | null>;
  send(workspaceId: string, message: ChatMessage): Promise<{ messageId: string }>;
  update(workspaceId: string, messageId: string, content: ChatMessage): Promise<void>;
  sendApproval(workspaceId: string, card: ApprovalCard): Promise<{ messageId: string }>;
  verify(req: HttpRequest): Promise<boolean>;
}
```

Trade-off: keeping the contract small (five methods) means a new platform can be added in one file without touching the engine core; the cost is that platform-specific affordances (modals, slash-command auto-complete) live inside the adapter and are not exposed to the engine in a uniform way.

A single engine instance can host multiple adapters simultaneously. Inbound traffic is routed by URL prefix (`/v1/chat/slack/*`, `/v1/chat/teams/*`, `/v1/chat/google/*`); outbound traffic is dispatched by the `platform` field on the `Chat Workspace` row.

## Per-platform summary

| Concern | Slack | Microsoft Teams | Google Chat |
|---|---|---|---|
| Inbound transport | Events API + Interactivity callbacks | Bot Framework activity feed | Google Chat bot event webhook |
| Outbound API | `chat.postMessage` / `chat.update` / `chat.postEphemeral` / `views.open` | Bot Framework `conversations/{id}/activities` | `spaces/{name}/messages` and `:update` |
| Interactive elements | Block Kit (buttons, selects, modals) | Adaptive Cards (Action.Submit, Input.ChoiceSet) | Card v2 (Button, SelectionInput, TextInput) |
| Install auth | Slack OAuth v2 | Teams app manifest plus Bot Framework client-credentials | GCP OAuth + domain-wide install |
| Verification | `x-slack-signature` HMAC-SHA256 | Bot Framework JWT in `Authorization`, validated against JWKS | Google JWT in `Authorization`, validated against JWKS |

## Library choices

| Platform | Library | One-line rationale |
|---|---|---|
| Slack | `@slack/web-api` only | The smallest official package for outbound API calls; inbound signature verification is roughly 40 lines of app code. |
| Microsoft Teams | none new | Outbound uses `fetch`; the bearer comes from `openid-client` doing client-credentials against the Bot Framework token endpoint; inbound JWTs are validated by `jose` against the Bot Framework JWKS. |
| Google Chat | none new | Outbound uses `fetch`; service-account JWT signing is done by `jose`, exchanged via `openid-client`; inbound JWTs are validated by `jose`. |

Net dependency additions for full Slack + Teams + Google Chat support: **one package — `@slack/web-api`**. Trade-off: writing the Teams and Google Chat clients ourselves adds about 200 lines per platform but avoids two large SDKs whose feature sets we do not need.

## Progressive-edit streaming

Chat platforms do not stream tokens. The engine works around this with a **progressive-edit** strategy: post an initial message, then call `update` every roughly 500 milliseconds (or every N tokens, whichever comes first) until the assistant turn finishes. Each update carries the current partial text plus any finalized tool-call panels rendered as platform-native blocks/cards.

Trade-off: the 500 ms cadence is well under every platform's published rate limit (Slack ~1 msg/sec/channel for `chat.postMessage`; `chat.update` shares a similar bucket but is per-message, so successive updates of the same message are cheap). The result is a token-stream-like UX without violating rate limits.

Approval prompts are posted as **separate** interactive messages so they do not collide with the streaming edit. The streaming message remains a clean transcript of the assistant's reasoning, while the approval card sits next to it and resolves independently.

## Human-in-the-loop inside chat

When the structured-intent tool loop calls `request_human_approval`, the engine queues a Chat Delivery of kind `card`. The adapter renders the approval prompt as platform-native interactive elements:

- **Slack** — a Block Kit message with `actions` containing `Approve` and `Reject` buttons.
- **Teams** — an Adaptive Card with `Action.Submit` actions.
- **Google Chat** — a Card v2 with `Button` widgets bound to action ids.

The interaction callback is POSTed back to `/v1/chat/{platform}/interactions`. The adapter's `verify` method confirms the platform signature, the engine resolves the originating Chat Session (and therefore the Conversation), the user's Chat Identity is checked against the required Policy for the pending tool call, and the decision is injected as a tool result into the Conversation's tool loop. The loop resumes from exactly where it paused.

Trade-off: rendering approvals as native cards (instead of as inline buttons inside the streaming edit) means the approval card stays clickable even after several streaming updates have rewritten the original message body.

## Slash-command grammar

A uniform grammar across all platforms, normalized by every adapter into a single `ChatEvent`:

```
/subkit run <workflow> [key=value ...]
/subkit chat <prompt...>
/subkit skills list
/subkit executions tail <id>
/subkit connectors list
/subkit link
```

Plumbing differs per platform — Slack native slash commands, Teams bot commands plus messaging extensions, Google Chat slash commands — but every adapter normalizes inbound slash invocations into a `ChatEvent` of kind `slash_command` with `args` parsed into a flat record. Trade-off: a single grammar means operators can document one set of commands instead of three.

## Chat Workspace install

Install-time OAuth is per platform. A successful install writes a `chat_workspaces` row with the encrypted `bot_credentials`, the `default_channel`, and the platform-specific `workspace_id`. Subsequent inbound events are matched to the row by `(platform, workspace_id)` and outbound deliveries are dispatched through the same row.

## Chat Identity linking

Linking is **user-initiated** through the `/subkit link` slash command. The engine replies ephemerally with a 10-minute single-use signed deeplink to `PUBLIC_BASE_URL/chat/link?state=<jwt>`, signed with `jose`, carrying `(platform, workspace_id, platform_user_id, nonce, expires_at)`. The user clicks the link, completes the normal `oidc` login, and the engine writes a `chat_identities` row binding the platform user to the tenant User. The full flow is also documented in `11-identity-and-access.md`.

Messages from an unmapped chat user receive an ephemeral reminder to run `/subkit link` and are otherwise ignored. No anonymous policy is granted by default.

## Notification Rules and chat

Notification Rules target chat channels, not email. A rule matches `(event_pattern, workflow_id_pattern, status, request_source[], severity)` and lists one or more `(workspace_id, channel_id)` tuples. When an Event matches, the engine renders a compact card grounded in the relevant Skills (so the message is meaningful, not a raw payload dump) and queues one Chat Delivery per target.

Severity buckets:

| Severity | Routing default |
|---|---|
| `info` | Daytime channels only, suppressed during quiet hours. |
| `warn` | All targeted channels. |
| `error` | All targeted channels plus a per-tenant escalation channel if configured. |

Trade-off: severity buckets keep the rule grammar small while still letting operators control noise; finer-grained routing can be modeled by adding more rules.

## Rate limits and circuit breakers

Each platform enforces published per-workspace rate limits. The `chat.deliver` queue gates outbound traffic per workspace against these caps:

| Platform | Cap |
|---|---|
| Slack | ~1 message per second per channel for `chat.postMessage` |
| Microsoft Teams | ~4 messages per second per bot |
| Google Chat | ~60 requests per minute per space |

Exceeding the cap re-queues the delivery with a small backoff. Persistent failures (10 consecutive non-recoverable responses for the same channel) trip a per-channel circuit breaker for one hour, then enter a half-open probe state. Trade-off: per-channel granularity contains a misbehaving channel without affecting the rest of the workspace.

## Queues

| Queue | Direction | Workers consume |
|---|---|---|
| `chat.event` | Inbound | Normalized `ChatEvent` envelopes ready for dispatch into the Conversation tool loop or slash-command handlers. |
| `chat.deliver` | Outbound | Chat Delivery rows: new message, update, ephemeral, card. |

The `chat.event` worker is responsible for normalization and authentication mapping; it never blocks on LLM calls — it enqueues a follow-up onto `conversation.tool-call` for any work that needs the engine's tool loop.

## Testing

Adapter tests run against recorded fixtures (Slack events, Bot Framework activities, Google Chat bot events) in unit tests, and against ngrok-tunneled local bots registered in a test workspace for the integration suite (opt-in via env var). Trade-off: recorded fixtures are deterministic and fast; the opt-in tunneled tests catch real-world signature, install, and interactivity regressions before release.

## What chat does not do

- It does not deliver email; the engine has no SMTP and no email provider integration.
- It does not stream raw LLM tokens; it streams progressive edits because chat platforms do not support token streams.
- It does not bypass the Auth Provider chain; chat users authenticate through their Chat Identity, which resolves to a tenant User and walks the same Policy evaluator as REST.
