---
slug: sk-ref-chat
name: sk Platform Reference — External Chat
description: How sk ingests Slack, Teams, and Google Chat messages — signature verify, normalization to ChatEvent, the async dispatch pipeline, and the identity/workspace model that maps a platform user to an sk user.
tags: [sk-platform-reference, chat, slack, teams, google-chat, ingestion, identity]
scope: global
version: 1
---

# External Chat — Overview

sk runs governed conversations and workflows from inside team chat. A message in Slack, Microsoft Teams, or Google Chat becomes an authenticated, audited turn against the sk conversation pipeline — the same pipeline the MCP and HTTP surfaces drive.

Supported inbound platforms: `slack`, `teams`, `google_chat`. These map 1:1 to the `chat_platform` Postgres enum and to a `chat_workspaces` row. There is also an outbound-only `sk_cli` pseudo-platform (local notification sink) that never ingests inbound traffic.

Email is NOT a supported chat channel. There is no email ingestion route, no email adapter, and no email platform value. Do not claim sk receives chat over email.

Pipeline shape (every platform): inbound HTTP route → `adapter.verify()` → `adapter.receive()` normalizes to a `ChatEvent` → enqueue a `chat.event` pg-boss job → return `200 {ok:true}` fast → async worker runs the dispatcher → conversation turn → reply posted back into the thread.

# Ingestion Routes

All inbound routes are plain Hono `POST` handlers. They sit OUTSIDE the OpenAPI catalog because the request payloads are platform-owned (Slack/Bot Framework/Google envelopes).

| Route | Platform | Carries |
|---|---|---|
| `POST /v1/chat/slack/events` | slack | Events API (`app_mention`, `url_verification`) |
| `POST /v1/chat/slack/interactions` | slack | Block Kit interactions (button clicks, `view_submission`) |
| `POST /v1/chat/slack/slash` | slack | Slash commands |
| `POST /v1/chat/teams/messages` | teams | Bot Framework activities |
| `POST /v1/chat/google/events` | google_chat | Google Chat events |

The slash route path is `/v1/chat/slack/slash` (namespaced under `slack` for consistency). Internal comments and some prose call it "the slash route" / `/v1/chat/slash`; the actually-registered path is `/v1/chat/slack/slash`.

Per-route handler steps:
1. Pull the adapter for the platform from the registry (`registry.findVerifier(platform)`).
2. Slack `url_verification` handshake short-circuit (see below) runs first.
3. If no adapter is registered → `503 {error:"adapter_not_registered"}`.
4. `adapter.verify(req)` → on failure `401 {error:"bad_signature"}` + a durable `chat.message.denied` audit row.
5. `adapter.receive(verified)` → normalized `ChatEvent`.
6. Optional synchronous fast path (`adapter.handleSyncInteraction`) for deadline-bound interactions.
7. Enqueue the `chat.event` job and return `200 {ok:true}`.

# Slack url_verification Handshake

When an operator configures an Events API request URL, Slack first POSTs `{type:"url_verification", challenge:"<str>"}`. sk must echo the challenge before any workspace is installed (chicken-and-egg: the operator can't install a workspace until app setup completes, and app setup requires a verified URL).

Behavior: the route peeks the raw body (cap 8 KB — the legitimate handshake is ~100 bytes), and if `platform === "slack"` and the parsed body has `type === "url_verification"` with a string `challenge`, it returns `200 {challenge:"<str>"}`. This short-circuit runs BEFORE the adapter-not-registered check, so a fresh engine answers the challenge with no install present. The handshake carries no exploitable payload; real events route past the peek into `verify()`.

# Signature Verification (per platform)

Verification is per-platform and mandatory. A failed verify returns `401 {error:"bad_signature"}` and writes a `chat.message.denied` audit row (durable `auditAwait`, never fire-and-forget — a bad signature is a security event and must not be dropped on a crash).

Slack: HMAC-SHA256. Signature base string is `v0:{timestamp}:{body}`, MAC keyed by the workspace signing secret, formatted `v0=<hex>`. Headers: `x-slack-signature`, `x-slack-request-timestamp`. Replay protection rejects timestamps older than 5 minutes (clock-skew tolerance, default 300 s). Constant-time compare (`timingSafeEqual`). Missing headers / non-numeric timestamp / length mismatch / stale → reject.

Teams: Bot Framework JWT. Reads `Authorization: Bearer <jwt>`, verifies the token against AAD's JWKS via `jose.jwtVerify`, checking expected `issuer` and `audience` (the bot's app id). Missing Bearer header or invalid JWT → reject (`jwt_invalid`).

Google Chat: service-account JWT. Reads `Authorization: Bearer <jwt>`, verifies against the configured JWKS via `jose.jwtVerify`. Default expected issuer is `chat@system.gserviceaccount.com`; audience is the bot's client id. Missing Bearer header or invalid JWT → reject.

Outbound auth is separate from inbound verify: Teams uses an AAD `client_credentials` token (`https://api.botframework.com/.default`), Google uses a signed service-account JWT-bearer assertion (`https://www.googleapis.com/auth/chat.bot`), both cached until `expires_in - 60s`. Slack outbound uses the stored bot token.

# Normalization — ChatEvent

`adapter.receive()` turns a verified raw envelope into a provider-neutral `ChatEvent`:

- `platform`: `"slack" | "teams" | "google_chat"`
- `workspace_id`: platform-native workspace/team id (string)
- `channel_id`, optional `thread_id`
- `user_id`: platform-native sender id (NOT yet an sk user)
- `kind`: `"mention" | "slash_command" | "interaction"`
- `text?`, `command?` (`ChatCommand`), `interaction?` (`ChatInteractionAction` with `action_id`, `value`, `form_values`)
- `event_key?`: platform-native event id for replay dedup — Slack `event_id` (Events API), `view.id` (`view_submission`), `trigger_id` (`block_actions`), or a hash of `command+text+ts` (slash)
- `raw`: the original payload

The `chat.event` queue job is `{event: ChatEvent}`, schema-validated at the worker boundary (`ChatEventJobSchema`) so an enqueue/dequeue drift across deploys fails loudly instead of dispatching a malformed event. Queue name constant: `chat.event` (`CHAT_EVENT_QUEUE`).

# Async Dispatch Pipeline

Platforms expect a fast HTTP ack, so real work happens out-of-band. The route enqueues `chat.event`; the queue handler calls `handleChatEvent(deps, event)`. Dispatcher steps:

1. Look up `chat_workspaces` by `(platform, workspace_id)` → tenant. No row → `workspace_not_found` (event dropped).
2. Resolve `chat_identities` by `(platform, workspace_id, platform_user_id)` → sk `user_id`. Explicit link required (see Identity Model). Unknown sender or tenant mismatch → deny.
3. Resolve / create a `chat_sessions` row (thread → `conversation_id`).
4. Route by event:
   - mention / `chat <prompt>` → `createConversation` or `appendUserMessage` + `runConversationTurn`
   - `/new` or `/reset` → drop the `chat_sessions` thread binding so the next message starts a fresh conversation (the conversation row itself is left intact for audit)
   - interaction (Block Kit click / `view_submission`) → `respondElicitation` with the typed output the adapter extracted
   - `/subkit run <slug-or-id> [k=v ...]` → RBAC `workflow:run` check, then `createExecution` + enqueue run
   - anything else → ephemeral help text
5. On `awaiting_input`, render the elicitation natively if the adapter declares `capabilities.interactive.includes(kind)`, else fall back to a legacy Approve/Reject card.
6. On completion, post the assistant reply back into the originating thread.

The turn runs under a synthetic chat principal resolved from the linked sk user (`resolveChatPrincipal`), so RBAC (workflow runs, conversation tools, credential access) is gated on that user's real role/group/grant ladder — not elevated.

# Identity Model — chat_workspaces & chat_identities

`chat_workspaces` binds a platform workspace to a tenant and stores the bot credentials:
- Columns: `tenant_id`, `platform`, `workspace_id` (native), `default_channel`, and the bot token as AES-256-GCM ciphertext (`bot_ciphertext` / `bot_iv` / `bot_auth_tag`, keyed by `MASTER_KEY`).
- Uniqueness: per-tenant `(tenant_id, platform, workspace_id)` AND a GLOBAL `(platform, workspace_id)` unique index. The global index is the tenant-isolation guarantee: a real-world workspace (Slack `team_id` etc.) belongs to exactly ONE tenant, so pre-tenant lookups keyed on `(platform, workspace_id)` resolve deterministically.

`chat_identities` maps a platform user to an sk user:
- Columns: `tenant_id`, `user_id` (sk user FK), `platform`, `workspace_id`, `platform_user_id`, `linked_at`.
- Unique on `(platform, workspace_id, platform_user_id)` (global) — a given platform user links to one sk user.

No implicit elevation. There is NO auto-link-to-admin: a chat user who can message the bot is NOT silently made tenant admin. An explicit link must exist. Links are created two ways:
- Installer: bound at install via `POST /v1/chat/workspaces` with `installer_platform_user_id`.
- Everyone else: an admin links them via `POST /v1/chat/identities`.

Other chat tables: `chat_sessions` (thread → conversation binding, unique per `(workspace_id, thread_id)`), `chat_events_seen` (replay dedup), `chat_deliveries` (outbound delivery log).

# Unknown / Denied Senders

If the dispatcher finds no `chat_identities` row for the sender, or a row whose `tenant_id` doesn't match the workspace's tenant (`identity_tenant_mismatch`, defense-in-depth), the event is denied:
- An ephemeral reply tells the user their account isn't linked and to ask an admin to link via `POST /v1/chat/identities`.
- A durable `chat.message.denied` audit row is written (`reason`: `identity_not_linked` or `identity_tenant_mismatch`), with `platform`, `workspace_id`, `platform_user_id`, `kind` metadata.
- No conversation turn runs.

A successful, linked message writes a `chat.message.received` audit row (actor = the sk user). A `/subkit run` denied by RBAC writes a `policy.denied` row against the workflow.

# Replay Dedup

Slack retries each Events API POST up to 3× with the same `event_id`. `chat_events_seen` prevents re-running a turn: the worker attempts an INSERT of `(workspace_id, platform_event_id)` and treats a unique-violation as "already seen", dropping the duplicate before touching the conversation pipeline. A scheduled retention sweep prunes old rows. `platform_event_id` is the same native id stored in `ChatEvent.event_key`.

# Admin & Install Routes

These are OpenAPI/Zod routes (governed, RBAC-gated), distinct from the platform ingestion routes:

| Route | Purpose |
|---|---|
| `POST /v1/chat/workspaces` | Install a workspace; encrypts the bot token; binds the installer's platform user via `installer_platform_user_id` |
| `GET /v1/chat/workspaces` | List installed workspaces |
| `DELETE /v1/chat/workspaces/{id}` | Remove a workspace (also unregisters the in-memory adapter) |
| `POST /v1/chat/identities` | Link a platform user (`platform`, `workspace_id`, `platform_user_id`) to an sk `user_id` |
| `GET /v1/chat/identities` | List links |
| `DELETE /v1/chat/identities/{id}` | Unlink |

The registry binds adapters to a `(tenant, platform, workspace)` triple, hydrated from `chat_workspaces` at boot. Removing a workspace unregisters its adapter so outbound traffic can't outlive the install.

# Rate Limits

Per-platform outbound ceilings (`CHAT_RATES`, token bucket keyed on `(tenant_id, workspace_id, channel_id)`):
- slack: 60/min, burst 20
- teams: 30/min, burst 10
- google_chat: 60/min, burst 20
- sk_cli: 0 (local INSERT, no remote API, limiter skipped)

On a rate-limit trip, conversation sends do NOT throw — they record `dropped_rate_limited` and return a synthetic message id so the state machine advances. Notification dispatch runs its own bucket and skips the inner limiter to avoid double-counting tokens.
