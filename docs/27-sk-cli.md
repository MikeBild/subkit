# 27 — The `sk` end-user CLI

`sk` is subkit's end-user binary, modeled after Anthropic's Claude Code and OpenAI's Codex CLI. Its job is to give any authenticated principal — admin, member, enduser, or portal-token customer — a conversational surface into the subkit engine that feels indistinguishable from the reference tools, while remaining a thin client over the engine's existing `/v1/conversations` REST surface.

Core design principle: **backend-only LLM**. The binary never holds provider API keys and never calls Anthropic or OpenAI directly. Every turn flows through the engine's `converse` flow, which owns model routing, token budgets, skills, drift repair, and audit. This is the tradeoff against Claude Code's local-shell model: you lose the ability to run `Bash/Read/Edit/Write` on the user's machine from inside the loop, and you gain server-side governance, observability, and multi-tenant isolation.

## The four personas

`sk` is persona-aware from the first paint. On startup it calls `POST /v1/rbac/can` with the full slash-command permission set and uses the result to (a) decorate the status line, (b) filter the `/` autocomplete menu, and (c) short-circuit commands the engine would deny.

| Persona | Role | Slash commands | Cannot |
|---|---|---|---|
| **admin** | `admin` | every command | — |
| **member** | `member` | every chat command, plus `/model`, `/compact`, `/skills`, `/mcp`, `/tenant` | `/audit` (audit:read not granted), workflow:delete |
| **enduser** | `enduser` | chat + session management (`/clear`, `/compact`, `/resume`, `/model`, `/memory`, `/init`) | `/skills`, `/mcp`, `/audit`, `/tenant`, `conversation:commit` |
| **portal-token** | `portal_token_user` | chat + cancel only | `/tenant` (blocked client-side), `/resume` (no `conversation:list`), `/skills`, `/mcp`, `/audit`, cross-workflow access |

End-to-end coverage for every persona lives in `apps/engine/src/tests/journeys/sk-cli-0{1..5}-*.journey.test.ts`. The rbac matrix test (`sk-cli-05-rbac-matrix.journey.test.ts`) is the guardrail against drift — it exercises every (role × new permission) pair via `POST /v1/rbac/can` on every run.

## Authentication

- `sk login --api-key <key>` writes an API-key profile to `~/.sk/config.json`.
- `sk login --portal-token <token>` writes a portal-token profile and marks it `portal_locked: true` so `sk tenants use ...` refuses up front. 
- OIDC device flow is not yet wired into `sk` itself — use `subkit login` (the operator CLI, which already implements the device flow against `runDeviceFlow`) and `sk` will pick up the resulting API key.
- The config file supports multiple named profiles; `--profile <name>` or `SK_PROFILE=...` switches profiles on invocation.

Precedence order for every effective field: CLI flag → env var (`SUBKIT_ENGINE_URL`, `SUBKIT_API_KEY`, `SUBKIT_TENANT`) → disk → default. Identical to `subkit`.

## Headless mode (`sk -p "..."`)

Designed for scripts and CI. Takes a prompt, drives a single conversation turn, and prints the result:

| Flag | Behaviour |
|---|---|
| `--output text` (default) | final assistant message on stdout, exit 0 on success |
| `--output json` | single JSON blob with `session_id`, `assistant_text`, `tool_calls`, `usage`, `warnings` |
| `--output stream-json` | NDJSON, one `TurnEvent` per line — shape-compatible with Claude Code's stream-json |
| `--no-memory` | skip `SUBKIT.md` injection for this invocation |
| `-c` / `-r <id>` / `--session-id` | continue / resume / attach to a specific conversation |
| `--connector <slug>` / `--workflow <id>` | bind a fresh conversation to a connector or workflow |

Exit codes mirror `subkit`: 0 success, 1 engine validation error, 2 auth / network / permission failure.

## Memory (`SUBKIT.md`)

`sk` walks upward from cwd looking for `SUBKIT.md` and also reads `~/.sk/SUBKIT.md`. Both files are merged (user first, project second so project wins) and sent to the engine as the `memory` field on every turn. The engine persists the payload on `conversations.memory` and slots it into the LLM context-assembly pipeline under a dedicated **User memory** section, between workflow skills and ingested connector docs — see `docs/16-ai-flows.md` for the full trimming order.

`memory:write` is a new permission (0018 migration) and is granted to admin + member but not enduser or portal-token, so endusers use the feature read-only today.

## Settings

Layered, user → project → local. Later wins.

1. `~/.sk/settings.json`
2. `.sk/settings.json` (walked upward from cwd)
3. `.sk/settings.local.json` (git-ignored)

Schema (all optional):

```ts
{
  model?: string,                        // per-session model override for new conversations
  defaultTenant?: string,
  additionalDirectories?: string[],      // extra dirs @-mention resolver may read from
  statusLine?: { format?, showCost?, showTokens?, showPersona? },
  mcpServers?: Record<string, McpServerConfig>,
  includeMemoryFile?: boolean,           // default true
  maxInlineMentionBytes?: number,        // default 262144
  headless?: { maxTurns?: number, maxBudgetTokens?: number }
}
```

## `@` mentions

The composer and the headless driver both resolve `@...` references before sending the prompt:

- `@path/to/file` — inline file contents (cwd + `additionalDirectories` scoped; `..` traversal rejected)
- `@workflow:<slug>` — fetch workflow JSON via `/v1/workflows/:slug` (requires `workflow:read`)
- `@execution:<id>` — fetch execution detail via `/v1/executions/:id` (requires `execution:read`)

Files larger than `maxInlineMentionBytes` are truncated with a visible marker. Errors become soft warnings surfaced on stderr.

## Slash commands

Every command is a declarative entry in `apps/sk/src/slash.ts`. Adding one is a single-file drop-in. Persona filtering is automatic — commands with a `requires` permission are hidden for personas that cannot invoke them.

| Slash | Requires | Notes |
|---|---|---|
| `/help` | — | Persona-aware cheat sheet |
| `/clear` / `/new` | `conversation:write` | Start a new session |
| `/compact` | `conversation:write` | `POST /v1/conversations/:id/compact` |
| `/resume` | `conversation:list` | `GET /v1/conversations?owner=me` picker |
| `/status` | — | Profile + engine snapshot |
| `/cost` | — | Turn-token + remaining monthly budget |
| `/model` | `conversation:write` | `PATCH /v1/conversations/:id {model}` |
| `/login` `/logout` | — | Profile management |
| `/tenant` | `identity:read` | Hidden for portal-token profiles |
| `/memory` | — | Opens `SUBKIT.md` in `$EDITOR` |
| `/init` | `conversation:write` | Generate a starter `SUBKIT.md` via a throwaway turn |
| `/skills` | `skill:read` | List active skills in scope |
| `/knowledge` | `knowledge:read` | Search active knowledge sources in scope |
| `/mcp` | `mcp:read` | List MCP prompts / resources / tools |
| `/config` | — | Open the merged settings JSON |
| `/permissions` | — | Bulk `POST /v1/rbac/can` probe |
| `/audit` | `audit:read` | Tail `/v1/audit-log?actor_id=me` — admin only |
| `/logs` | `admin:read` | Tail recent engine errors |
| `/debug` | — | Print last engine request/response for diagnostics |
| `/paste` | — | Paste the system clipboard into the composer |
| `/attach <path>` | — | Attach a local file to the next turn |
| `/profile` | — | List or switch profiles (alias of `/env`) |
| `/queue` | — | Show prompts queued while a turn is running |
| `/history` | — | Show / clear the persistent prompt history file |
| `/exit` / `/quit` | — | Unmount the REPL |
| `/bug` | — | Opens GitHub issue template |

Draft authoring inspectors are also exposed as slash commands so the user can browse engine-side state between turns:

| Slash | Requires | Notes |
|---|---|---|
| `/draft` | `conversation:read` | Current draft overview (mode / readiness / next action) |
| `/connector` | `conversation:read` | Connector draft pane — fields, validation, latest probe |
| `/workflow` | `conversation:read` | Workflow draft pane — steps, edges, latest preview |
| `/templates` | `conversation:read` | Connector templates pane (prefill accelerators) |
| `/probe` | `conversation:write` | Trigger `probe_connector_draft` via message append; `/probe show` renders the last recorded probe |
| `/preview` | `conversation:write` | Trigger `dry_run_step` / `dry_run_workflow`; `/preview show` renders the last preview |
| `/versions` | `workflow:read` | List committed versions of the bound workflow |
| `/restore <n>` | `workflow:write` | Restore a prior workflow version as a new current version |
| `/context` | `conversation:read` | Loaded skills, knowledge, docs, attachments, memory |
| `/approve` `/reject` | `conversation:write` | Resolve the pending elicitation without typing free-form |

## MCP

Two distinct roles for MCP in the `sk` binary:

1. **Client-side slash-command surfacing.** Settings' `mcpServers` block is forwarded to the engine on conversation create. Prompts and resources from `GET /v1/mcp/prompts` + `GET /v1/mcp/resources` appear in the slash picker as `/mcp__<server>__<prompt>`. Gated on `mcp:read`.
2. **`sk mcp` stdio proxy.** Identical to the existing `subkit mcp` proxy — IDE plugins launch it to reach the engine's MCP surface through a local stdio transport. Deferred to a follow-up PR.

## Audit provenance

Every `sk`-originated action is tagged with `user-agent: sk-cli/<version>` and every sensitive operation emits an audit row via `auditAwait`. New action names land in `apps/engine/src/audit/types.ts`:

- `conversation.compacted` / `conversation.updated` / `conversation.memory_injected` / `conversation.resumed`
- `sk_cli.login` / `sk_cli.logout` / `sk_cli.tenant_switched` (emitted when the caller's user-agent begins `sk-cli/`)

Combined with the existing `conversation.created / completed / cancelled / committed` + `approval.*` + `policy.denied` families, every `sk` session has a faithful provenance chain that SOC2 reviewers can replay via `GET /v1/audit-log` or `GET /v1/audit-log/export.ndjson`.

## Coming from Claude Code

| Claude Code | `sk` equivalent |
|---|---|
| `claude` | `sk` |
| `claude -p "..."` | `sk -p "..."` |
| `claude -c` / `claude -r` | `sk -c` / `sk -r` |
| `CLAUDE.md` | `SUBKIT.md` |
| `~/.claude/settings.json` | `~/.sk/settings.json` |
| `/model` `/compact` `/clear` `/memory` `/init` `/resume` `/login` `/logout` `/status` `/cost` `/help` `/bug` `/mcp` `/config` `/exit` | same |
| `.claude/agents/*.md` | **not yet** (deferred past v1) |
| `PreToolUse / PostToolUse / Stop hooks` | **not yet** (remote tools only in v1) |
| `Bash / Read / Edit / Write / Grep` local tools | **not in v1** — tools are the engine's structured-intent palette (`propose_step`, `update_param`, `connect_steps`, `dry_run_step`, `validate_draft`, `request_human_approval`, `commit_draft`) |
