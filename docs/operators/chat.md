# Chat Channels

**Use sk from the chat your team already lives in.** Link a Google Chat
space (Slack and Microsoft Teams follow the same model) and every
member you approve can ask questions, look up workflows, skills,
knowledge, and executions, and run saved workflows — with the same
RBAC, confirmation gates, and audit trail as every other surface. The
channel is deliberately **read-only**: nobody can build or change
connectors, workflows, skills, or knowledge sources from chat, no
matter which role their linked account holds.

> **Not to be confused with the `google-chat` connector template.** The
> connector catalog also contains a "Google Chat" connector used to
> *post* messages into a space as a workflow step. It shares no
> configuration, credentials, or code with the chat channel described
> here. If you want people to *talk to sk from* Google Chat, you're in
> the right doc; if you want a workflow to *send a message to* a space,
> that's the connector, not this.

```mermaid
flowchart LR
    u([Space member message]) --> ev[POST /v1/chat/google/events]
    ev --> ver{JWT verify<br/>aud = project number}
    ver -->|bad| deny([401 + audit])
    ver -->|ok| q[chat.event queue<br/>fast ack]
    q --> id{Identity linked?}
    id -->|no| rej([polite rejection + audit])
    id -->|yes| turn[Conversation turn<br/>read-only palette]
    turn --> reply[Reply into the space]
    turn --> card[Approval card<br/>for workflow runs]
```

## What the channel can and cannot do

| Can | Cannot |
|---|---|
| Answer questions (LLM chat with tenant context) | Create or edit connectors, workflows, skills, knowledge sources |
| List/inspect workflows, executions, skills, knowledge, connector metadata, schedules | Call connectors directly (no `call_connector`, probe, test, discover) |
| Run saved workflows — behind RBAC + a confirmation card | Change roles, keys, schedules, or any tenant resource |
| Ask about files already uploaded to sk (list + preview attachments) | Receive or ingest files posted into the space |

The restriction is **channel-scoped, not role-scoped**: an admin who
asks the bot to "create a stripe connector" gets a one-sentence
redirect to the sk CLI or web portal. Enforcement is structural — the
chat surface assembles a fixed read-only tool palette, harness-side
write dispatch refuses mutating intents on this surface, and per-user
RBAC still applies underneath as the second layer.

### How the bot asks for input

When a turn needs something from you, the bot renders the prompt
natively in Google Chat:

- **Yes/no confirmations, single choices, and multi-selects** arrive
  as interactive cards in the space — click to answer.
- **Free-text questions and multi-field forms** arrive as a card with
  a button that opens a native Google Chat dialog.
- **Typing instead of clicking works for simple prompts**: a plain
  typed reply resolves a pending free-text question (or a one-field
  form) directly. For button prompts and multi-field forms the bot
  points you back to the widget instead of guessing.
- Only the person the bot asked can answer — the same shared-space
  contract as run confirmations.

### Attachments are not ingested

Google Chat delivers only message text and interaction payloads to
the app — files dropped into a space never reach sk, so the bot
cannot read, summarize, or run a workflow over an attachment posted
in chat. To work with a file, upload it to sk first via the sk CLI or
the web portal; the bot can then list and preview the tenant's
attachments and answer questions about them.

## Message formatting

The assistant writes standard Markdown; sk converts it to each
platform's native text dialect before sending, so replies render
cleanly instead of showing literal `**` asterisks or bullet
characters. What renders correctly:

| Construct | Google Chat & Slack |
|---|---|
| Bold, italic, strikethrough | rendered (single-asterisk `*bold*`, `_italic_`, `~strike~`) |
| Inline code and short code blocks | rendered as monospace / fenced blocks |
| Bullet lists (incl. nested) | rendered |
| Links | rendered as tappable links |
| Blockquotes | rendered |

What has **no** clean chat equivalent, even after conversion:

- **Headings** degrade to a bold line (neither platform has heading
  syntax).
- **Numbered lists** display as literal `1.`, `2.` lines — legible, but
  the platform does not auto-renumber them.
- **Tables** have no real chat equivalent and fall back to a fenced
  monospace block. If someone needs tabular data in chat, ask the bot
  for it as a list rather than a table for the cleanest result.

Teams and the sk CLI render full Markdown natively, so no conversion is
applied there.

## Conversation memory: one conversation per space

- **A space (channel) keeps one running conversation.** Every top-level
  message continues it, so the bot remembers the topic across days.
- **A reply inside a thread gets its own focused conversation** —
  threads are sub-topics.
- **A DM with the bot is one continuous personal conversation.**
- Send `/new` (or `/reset`) to drop the binding and start fresh.

Privacy note: all linked members of a space share that space's
conversation history — that is the point of topic memory. Do not
discuss things with the bot in a team space you would not post there
yourself. Each turn still runs under the *sender's* permissions, and
only the person who initiated a workflow-run confirmation can approve
its card.

## Direct messages (DMs)

A 1:1 chat with the bot is its own space (Google marks it
`DIRECT_MESSAGE`) with one continuous personal conversation — no
threads. Registration is mostly automatic on Google Chat:

- **A user already linked in another space of your tenant can just
  DM the bot.** sk recognizes the sender's linked identity,
  auto-registers the DM space under that tenant, and answers the very
  first message — a normal governed read-only turn under the user's
  real role. The install is audited (chat-workspace-installed,
  `dm_autoregister`); no manual registration call is needed.
- **An unlinked sender is politely refused.** The message is dropped
  with a `chat.message.denied` audit row (reason
  `dm_sender_not_linked`, recorded under the platform-system tenant
  since no tenant is known), and the sender gets the generic
  "not connected" reply. Link the user in a team space first (see
  *Link members* below), then the DM works.
- **A user linked in more than one tenant is refused** (reason
  `dm_sender_ambiguous`) — sk never guesses which tenant a DM belongs
  to. Pin it manually: register the DM space with `POST
  /v1/chat/workspaces` under the intended tenant and link the
  identity for that space, exactly like a group space.
- **Slack and Teams DMs will not auto-register.** Their user ids are
  workspace-scoped, so a cross-workspace identity match could bridge
  tenants; DM spaces on those platforms need the manual per-space
  install.

DM users run under their linked account's role like everyone else —
see [Which role should linked chat users
have?](#which-role-should-linked-chat-users-have) for guidance.

## Set up Google Chat

Prerequisites: a Google Workspace domain (consumer `@gmail.com`
accounts cannot install custom Chat apps), a GCP project, and a public
HTTPS route to the engine.

> Worth knowing before you start: Google Chat can always deliver an
> in-chat "this space isn't connected" reply for an unregistered space,
> so a misconfigured Google space tells you so. Slack generally cannot
> (its bot tokens are workspace-scoped), so an unregistered Slack space
> just stays silent — on Slack, check the audit log rather than waiting
> for an error in the channel.

1. **GCP project** — enable the *Google Chat API*.
2. **Service account** — create one, download a JSON key; you need
   `client_email` and `private_key`.
3. **Configure the Chat app** (Chat API → *Configuration*):
   - Leave **"Build this Chat app as a Google Workspace add-on"
     UNCHECKED** — sk speaks the classic HTTP-app contract; the add-on
     style uses a different verifier and payload and will not work.
   - App name, avatar URL, description; enable *Interactive features*;
     check *Join spaces and group conversations*.
   - Connection settings: **HTTP endpoint URL** =
     `https://<engine-host>/v1/chat/google/events`.
   - **Authentication Audience: "Project Number"** (not "HTTP endpoint
     URL") — sk verifies inbound JWTs against this audience.
   - Visibility: your domain users (up to 25 testers without a
     Marketplace listing).
4. **Engine config.** These three leaves are **engine-global** (shared
   by every tenant on this engine — see *Adding a second tenant* below)
   and marked `requiresRestart`. On a production engine
   (`NODE_ENV=production`) each write is rejected unless you pass
   `--force`:

   ```bash
   sk settings set platform.googlechat.client_email "<sa>@<project>.iam.gserviceaccount.com" --force
   sk settings set platform.googlechat.private_key "$(cat key.pem)" --force
   sk settings set platform.googlechat.audience "<project number>" --force
   ```

   **What "restart required" actually means here:** the write takes
   effect in the running process immediately — `sk settings get
   platform.googlechat.client_email` shows the new value right away, and
   a chat event handled by this process picks it up on its next
   workspace-hydration. The restart caveat only matters for (a) *other*
   already-running instances in a multi-instance deploy, and (b) an
   already-hydrated adapter in this process, which rebuilds on the next
   registry install/miss. In a single-instance deployment you almost
   never need to bounce a live engine for this — confirm with `sk
   settings get` and only restart if a workspace still fails to hydrate.

   **`private_key` is the most common copy/paste failure here:** shell
   quoting can silently collapse newlines or trailing whitespace inside
   the PEM, and there is no key-validation step — a mangled key isn't
   caught until an outbound send fails later. Use `$(cat key.pem)`
   verbatim as shown, then run `sk settings get
   platform.googlechat.private_key` to confirm the leaf is recorded (the
   value comes back masked, but a masked-but-present result confirms it
   isn't empty).

5. **Install each space** — add the app to the space in Google Chat,
   then register the space with your tenant (one install per space;
   Google events carry no domain id). Two ways to get the space id
   (`spaces/AAAA...`): copy it from the space URL (always works), or —
   if the space is already messaging the bot and failing — find the
   `chat.message.denied` audit row with `reason: "workspace_not_installed"`
   and read its `metadata.workspace_id_native`. (There is no dedicated
   "app added to space" audit action; don't grep logs for one.)

   ```bash
   curl -X POST https://<engine-host>/v1/chat/workspaces \
     -H "Authorization: Bearer $SK_ADMIN_KEY" -H "content-type: application/json" \
     -d '{"platform":"google_chat","workspace_id":"spaces/AAAA...",
          "installer_platform_user_id":"users/1234567890"}'
   ```

   No `bot_token` — Google outbound auth uses the app-level service
   account from engine config.

6. **Link members** — unknown senders get a polite rejection and a
   `chat.message.denied` audit row. Link each user (their Google id is
   in that audit row's metadata):

   ```bash
   curl -X POST https://<engine-host>/v1/chat/identities \
     -H "Authorization: Bearer $SK_ADMIN_KEY" -H "content-type: application/json" \
     -d '{"platform":"google_chat","workspace_id":"spaces/AAAA...",
          "platform_user_id":"users/1234567890","user_id":"<subkit-user-uuid>"}'
   ```

### Adding a second tenant on an already-configured engine

`platform.googlechat.*` credentials are **engine-global** — one Google
Chat app / service account serves every tenant on this engine. If
Google Chat already works for tenant A and you're bringing tenant B
onto the same engine, **do not repeat step 4**: re-running it with a
different service account would break tenant A, and re-running it with
the same values is an unnecessary no-op. Attempting to scope these
leaves per-tenant (`--tenant <id>`) is rejected outright — they are not
tenant-overlay settings. What *is* per-tenant is the space↔tenant
binding, so for each new tenant only repeat steps 5–6: install the
app in that tenant's space(s), then link its members.

## Which role should linked chat users have?

The built-in `enduser` role fits the channel: run + read workflows,
read executions, knowledge, and skills, converse — nothing else. Two
reads are deliberately **not** in `enduser`: `connector:read` (the bot
will refuse "which systems are connected?") and `schedule:read`. If
your chat users should see that metadata, create a custom role =
enduser permissions + `connector:read` + `schedule:read` and link
their identities to users holding it. Admin-linked users get admin
*reads and runs* — never authoring; the channel restriction does not
care about roles.

### Finding chat users who need to be linked

There's no dedicated "pending link requests" view. To find everyone who
has tried to message the bot in a workspace but isn't linked yet, pull
the denied-audit rows and filter by reason client-side (the audit API
doesn't filter on `reason` directly):

```bash
sk audit list --action chat.message.denied --json \
  | jq '.items[] | select(.reason=="identity_not_linked") | {ts, metadata}'
```

Each match's `metadata` carries the sender's platform user id
(`users/<id>` for Google Chat) — feed it into `POST /v1/chat/identities`
as in *Link members*. This is a point-in-time snapshot, not a live
queue; re-run it after onboarding a new group.

## Slash commands

| Command | Effect |
|---|---|
| `/subkit chat <prompt>` (or just mention the bot) | Continue the space conversation |
| `/subkit run <workflow-slug>` | Run a saved workflow — same RBAC + confirmation card as asking in prose |
| `/new` or `/reset` | Start a fresh conversation for this space/thread |

Naming the exact slug (`/subkit run <workflow-slug>`) always works. You
can also just describe what you want in plain prose (in any language) —
when it unambiguously identifies one saved workflow, the bot resolves
it (via the same fuzzy lookup behind `find_workflow`) and runs it
behind the normal confirmation card. If more than one workflow
plausibly matches, the bot asks which one instead of guessing. Naming
the slug is still the fastest, most reliable path.

## Troubleshooting

| Symptom | Look at |
|---|---|
| Bot never answers | Engine log `chat` module; `CHAT_WORKSPACE_HYDRATE_SKIPPED` audit (`google_credentials_unset` = config incomplete) |
| Bot replies "This space isn't connected to sk yet" | The space is not registered. The reply is generic and rate-limited (once per minute per space); the drop is audited as `chat.message.denied` under the platform-system tenant with the space name in metadata. Register it: `POST /v1/chat/workspaces` (see *Install each space*). On Slack this reply usually cannot be delivered (bot tokens are workspace-scoped), so an unregistered Slack space stays silent — check the audit row instead |
| DM gets the "not connected" reply | The sender is not linked in exactly one tenant — the `chat.message.denied` reason is `dm_sender_not_linked` (link them in a team space first) or `dm_sender_ambiguous` (register the DM space manually to pin the tenant); see *Direct messages (DMs)* |
| 401 on every event | Authentication Audience must be "Project Number" and match `platform.googlechat.audience`; app must be classic-style, not add-on |
| "Your chat account isn't linked" | `chat.message.denied` audit (`identity_not_linked`) carries the sender's `users/<id>` for the link call |
| Space stopped answering after the app was removed/re-added | Removal drops the space's session bindings by design; re-adding starts a fresh conversation |
| User clicks a confirmation card, nothing happens | Only the requester can confirm (`actor_not_owner` audit); the clicking user gets an in-channel note |
| Google shows "Subkit Chat Channels reagiert nicht" / "…isn't responding" after every message | Expected Google Chat behavior, not a sk failure. sk acknowledges the webhook immediately and posts the real reply asynchronously (turns can take seconds); Google's client shows this placeholder in the gap. A *real* failure looks different: no reply ever arrives, or a `chat.message.denied`/error audit row exists for that message |
| Google Chat send fails after setup looked clean | The `private_key` PEM likely got mangled by shell quoting during `sk settings set`. Re-run with `$(cat key.pem)` verbatim; there is no server-side key validation, so a bad key only surfaces as a failed outbound send, not a rejected `settings set` |

## Known friction / roadmap

Installing a space and linking members today means hand-rolling the
`curl` calls above against the HTTP API with an admin key — there is no
`sk chat install` / `sk chat link` convenience wrapping those two
routes yet. This is the single biggest rough edge in an otherwise
straightforward setup; a CLI wrapper is a natural follow-up. Until it
lands, keep the two `curl` templates handy — the request bodies are
stable.

## Slack and Microsoft Teams

The same channel contract (read-only palette, space memory, identity
linking, confirmation cards) applies to Slack and Teams; their
activation is tracked separately. Slack's adapter (signing-secret
verification, Block Kit, modals) already ships — setup docs land with
its rollout.
