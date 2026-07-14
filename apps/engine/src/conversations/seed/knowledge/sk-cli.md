---
slug: sk-ref-cli
name: sk Platform Reference — sk CLI
description: Exhaustive reference for the sk command-line client — every top-level command, headless mode, profiles, the sk mcp stdio proxy, settings, bootstrap flows, and the coding-agent integration commands (agent, learnings, skills sync).
tags: [sk-platform-reference, cli, sk-cli, headless, profiles, mcp, settings, bootstrap]
scope: global
version: 2
---

# sk CLI Overview

`sk` is the command-line client for a subkit engine. Bare `sk` opens an interactive REPL (Ink rich UI on a TTY, line-based readline when stdout is piped). Every subcommand is scriptable, prints to stdout, and accepts `--help`. The engine enforces RBAC on every API call; the CLI's persona-aware `--help` filtering is visibility-only and never a security boundary.

Two usage shapes:
- Conversational: `sk` (REPL) or `sk -p "<prompt>"` (headless) drive a guided conversation that authors, refines, runs, and commits workflows.
- Direct resource management: `sk workflows`, `sk connectors`, `sk executions`, `sk rbac`, etc. operate on engine resources without a conversation.

State lives under `~/.sk/`: `config.json` (profiles), `settings.json` (CLI settings), `sessions/` (cached conversation metadata), `debug.log` and `history.jsonl` (diagnostics).

# Installing / accessing the CLI

Install `sk` with a single shell one-liner — there is no package-manager step. The CLI is served **by the engine you are already talking to**. Where `<engine-url>` is that engine's base URL (the same base URL this chat/API runs on):

```
curl -fsSL <engine-url>/install | bash
```

The engine returns a POSIX install script that auto-detects your platform/arch, downloads the matching `sk` binary directly from that engine (`GET <engine-url>/install/sk-<os>-<arch>`), verifies its SHA256 against `<engine-url>/install/sha256sums`, and installs it to `~/.subkit/bin/sk`. Add `~/.subkit/bin` to your `PATH` if it is not already there. After installing, point `sk` at an engine and authenticate with `sk login` / `sk profile` (see below), or bootstrap a fresh engine with `sk init`. Keep the CLI current with `sk update`.

The engine `/install` endpoint is the single supported way to get the CLI. Concretely, `sk` is **not** published on npm — do not run `npm install` or `npx` to get it; no such package exists. There is **no** public download page, **no** `docker-compose` step to install the CLI, and no `sk login <url>`-as-installer step. Installation is only the `curl -fsSL <engine-url>/install | bash` one-liner above; `docker compose` runs the engine, not the CLI.

# Global Flags and Profile Resolution

Common flags accepted by most commands:
- `--engine-url <url>` — engine base URL (default `http://localhost:3000`).
- `--api-key <key>` — API key, sent as `Authorization: Bearer <key>`.
- `--tenant <id>` — active tenant id.
- `--profile <name>` — named profile from `~/.sk/config.json`.

Resolution precedence (highest first):
1. CLI flags (`--engine-url`, `--api-key`, `--tenant`, `--profile`).
2. Environment: `SUBKIT_ENGINE_URL`, `SUBKIT_API_KEY`, `SUBKIT_TENANT`, `SUBKIT_PROFILE` or `SK_PROFILE`.
3. On-disk fields from the selected profile.
4. Defaults.

Configuration is done with `sk settings` / `sk config set` (engine settings) and `sk profile` / `sk login` (local profiles). Never use `SK_OVERRIDE_*` environment variables to configure the engine — they are not a supported path; set engine settings through `sk settings set` instead.

# Profiles and ~/.sk/config.json

`~/.sk/config.json` holds multiple named profiles plus an `active_profile`. Shape:
```
{ "active_profile": "default", "profiles": { "default": { "engine_url", "api_key", "active_tenant_id", "persona_hint?", "portal_locked?", "notification_inbox_cursor?" } } }
```
The file is written `0600`. A signed-out profile drops `api_key` entirely (rather than persisting an empty string). The default profile name is `default`; the default engine URL is `http://localhost:3000`.

`sk profile` manages named profiles (environments): subcommands `add`, `delete`, `list`, `show`, `use`. Switch the active profile with `sk profile use <name>` or per-invocation with `--profile <name>`. At REPL runtime `/profile` opens the profile palette and `/tenant` switches tenant.

# Authentication: login, logout, status, tenants

`sk login` — authenticate against an engine and save the profile. Flags select the method:
- `--api-key <key>` — scripted API-key login (skips device flow).
- `--portal-token <token>` — authenticate as a portal-token principal (locks the profile to `portal_locked`).
- `--issuer-url`, `--client-id`, `--scope` — OIDC device flow overrides.
- With no `--api-key`, login discovers providers and falls back to the OIDC device flow or browser (Firebase/SSO) login.

`sk logout` — drop the active profile's credentials.

`sk status` — print the active profile and engine reachability.

`sk tenants` — list tenants you belong to, or switch the active one.

On a bare `sk` with no usable profile on a TTY, an onboarding picker offers: browser login, paste API key, point-at-engine / bootstrap (`sk init`), or device-code flow. Non-TTY callers instead get `sk: not logged in` on stderr and exit 2.

# Bootstrap: sk init and sk join

`sk init` — complete first-run engine bootstrap. Consumes the one-time token printed in the engine's first-boot startup banner. Flags: `--token <token>` (auto-detected from `SUBKIT_BOOTSTRAP_TOKEN_FILE` on the all-in-one Docker image), `--engine-url`, `--profile`, `--admin-email`, `--tenant-name`, `--llm-provider`, `--llm-api-key`. When admin-email, tenant-name, llm-provider, and llm-api-key are all supplied it runs fully headless; otherwise it prompts for the missing fields. Saves the resulting admin API key into the profile.

`sk join` — redeem a single-use invite token to provision your personal API key (no login required). Flags: `--token <token>` (from your admin), `--engine-url`, `--profile`. Writes the new key into the named profile.

`sk invites` (admin, `identity:read`) manages the invites these redeem: `list`, `revoke`.

# Headless Mode (sk -p)

`sk -p "<prompt>"` runs a single conversation turn end-to-end and prints the result, then exits. Flags:
- `--output text|json|stream-json` (default `text`).
  - `text` — final assistant prose; for a tool-only turn with no prose it renders the last succeeded execution payload so the command always answers.
  - `json` — one object: `session_id`, `status`, `assistant_text`, `messages`, `tool_calls`, `pending_elicitation`, `committed_workflow_id`, `validation_errors`, `usage`, `warnings`, `memory_sources`.
  - `stream-json` — one JSON object per SSE frame on stdout, unbuffered (plus `{"file_attached":...}` lines for attachments).
- `-c` — continue the most recent cached session for this profile/engine/tenant.
- `-r <conversation_id>` — resume a specific conversation.
- `--session-id <conversation_id>` — attach to a specific conversation (takes precedence over `-r`/`-c`).
- `--connector <slug>` / `--workflow <id>` — bind a new conversation to a connector or workflow.
- `--attach <path>` — repeatable; upload + link each file to the conversation before the prompt runs. A read/upload/link failure short-circuits the turn (exit 1, `ATTACH_FAILED`) so the prompt never runs against a partial attachment set.
- `--max-turns <n>` — per-turn model/tool step budget; integer 1–64.
- `--no-memory` — skip `SK.md` injection for this invocation.
- `--quiet` — suppress non-critical warnings on stderr.

Exit codes (headless): `0` clean, `1` engine validation/bad-request error or attach failure, `2` auth/permission/network failure. `@file` mentions and clipboard refs in the prompt are resolved before the turn.

# Interactive REPL and Slash Commands

Bare `sk` (optionally `sk "<initial prompt>"`, `sk -c`, `sk -r <id>`) opens the REPL. In-REPL slash commands (local = handled client-side; others call the engine):

Session/authoring: `/clear`, `/compact`, `/resume`, `/fork`, `/rename`, `/draft`, `/connector`, `/workflow`, `/context`, `/templates`, `/probe`, `/preview`, `/versions`, `/restore <version>`, `/onboard`, `/setup`.
Approvals/policy: `/approvals`, `/approve`, `/reject`, `/yolo` (arms a typed-confirmation bypass of the destructive-action gate; auto-disarms; `/yolo off`), `/policy <tool> <auto|ask|review|reset>`, `/permissions`.
Status/usage: `/status`, `/cost`, `/usage`, `/exec [execution_id]`, `/verbose`, `/model`, `/queue`, `/history`.
Identity: `/login`, `/logout`, `/profile [name]`, `/tenant`.
Context/files: `/memory` (open `SK.md` in `$EDITOR`), `/init` (generate a starter `SK.md`), `/files`, `/paste`, `/mention`, `/copy`, `/export`, `/view chat|inspect`. In the interactive REPL, pasted or dropped local file paths are handled directly by the composer; do not route users to `/attach` or `/upload`.
Discovery: `/skills`, `/knowledge`, `/mcp`, `/mcp-servers`, `/connectors`, `/workflows`, `/executions`.
Admin/config: `/config`, `/config-form`, `/settings` (5-tab palette: Status / Config / Usage / Skills / Knowledge), `/admin`, `/audit`, `/logs [limit] [trace_id]`, `/debug on|off|tail`, `/session <workflow-id>` (mint a short-lived portal token + QR code), `/actions`, `/feedback`, `/help`, `/exit`.

# sk mcp — stdio MCP Proxy

`sk mcp` runs a stdio Model Context Protocol server that proxies the most-used conversation surfaces to the engine, so an IDE/MCP client can drive sk without the TUI. It requires a logged-in profile (else `sk mcp: not logged in` / exit 2). It authenticates with the resolved profile — i.e. `--api-key`/`--engine-url` flags, the `SUBKIT_API_KEY`/`SUBKIT_ENGINE_URL` environment variables, or the on-disk profile — not any `SK_*`-named variable. (`SK_API_KEY` appears only as a placeholder in the curl/python snippets `sk workflows invoke-snippet` generates for your own scripts; the CLI itself does not read it.)

The proxy exposes a small local toolset that forwards to engine HTTP endpoints: ping the engine, create a conversation, append a message, fetch a conversation, and list your conversations. This stdio proxy is distinct from the engine's own remote MCP server: the engine's MCP palette (reached over HTTP at the engine URL by clients like claude.ai/ChatGPT) uses underscore tool names — `wf_<slug>`, `conversation_start`, `conversation_append`, `conversation_get`, `conversation_commit`, `conversation_respond_elicitation`, `run_workflow`, `search_knowledge`, `search_knowledge_v2`, `list_knowledge_sources`, `get_engine_status`, `whoami`, `get_token_budget`, `get_llm_usage`, `list_inbound_hooks`, `get_inbound_hook` — never dotted.

# sk settings — Engine Settings

`sk settings` lists, reads, writes, or interactively configures engine settings; secrets are always returned masked by the engine and never printed raw. Subcommands:
- `list` — every leaf with its resolved value, source (`default`/override), `secret`/`restart` flags, plus pending-restart and active-override diagnostics.
- `get <path>` — read one leaf by dotted path (e.g. `llm.api_key`), showing value, kind, scope/source, sensitivity, restart requirement, description.
- `set <path> <json>` — write one leaf; `<value>` must be valid JSON (`'"abc"'`, `42`, `true`, `null`). `--force` bypasses the `requiresRestart` guard in production.
- `configure` — interactive Ink palette (tabs: Status / Config / Usage / Skills / Knowledge); `--non-interactive` (auto-detected off a TTY) prints the `GET /v1/settings` payload as JSON instead.

All subcommands accept `--tenant <id>` to write a tenant overlay (only `scope: "tenant"` leaves are writable per tenant). This is the canonical way to configure the engine — prefer it over any environment-variable override.

`sk config set ...` is the equivalent settings-write entry surfaced in conversational guidance; engine settings are never set via `SK_OVERRIDE_*` env vars.

## CLI Settings (~/.sk/settings.json)

Distinct from engine settings, the CLI reads layered JSON (later wins): `~/.sk/settings.json` (user) → `<repo>/.sk/settings.json` (project, walked upward) → `<cwd>/.sk/settings.local.json` (local, git-ignored). Keys: `model`, `defaultTenant`, `additionalDirectories`, `statusLine` (`command`/`format`/`showCost`/`showTokens`/`showPersona`/`refreshMs`), `mcpServers`, `includeMemoryFile` (default true), `maxInlineMentionBytes` (default 262144), `headless` (`maxTurns`/`maxBudgetTokens`), `nextCommandPreviewEnabled` (default true). Unknown keys are preserved.

# Sessions: ls, show, rename, rm, sessions

Conversation sessions are cached locally in `~/.sk/sessions/` so `-c`/`-r` and aliases work without a round-trip; the server-side conversation row is independent.
- `sk ls` — list cached sessions for the active profile.
- `sk show <id|alias>` — show cached metadata for a session.
- `sk rename <id> <alias>` — assign/change a short alias used by `sk -r <alias>`.
- `sk rm <id>` — drop a session from the local cache (server-side row preserved).
- `sk sessions` — manage cached sessions with subcommands `ls`, `rename`, `rm`, `search`, `show`.

# Health, Doctor, Diagnostics, Logs

`sk health` — runtime posture: liveness, token budget, failing runs, risk signals, schema drift, process runtime.

`sk doctor` — diagnose engine connectivity, authentication, and setup. Exits `0` (ok or warn) or `2` (blocked). Use `sk doctor` for connectivity/setup; `sk health` for runtime posture.

`sk diagnostics` (`audit:read`) — engine diagnostics with subcommands `errors`, `llm`, `setup`.

`sk logs` (`audit:read`) — tail the engine runtime log ring. `--follow` streams via SSE; `--since` accepts `5m`/`2h`/`1d`/ISO-8601.

# Resource Commands (Operator)

- `sk workflows` (`workflow:read`) — `create`, `delete`, `dry-run`, `get`, `history`, `invoke-snippet`, `list`, `preview`, `restore`, `run`, `validate`.
- `sk connectors` (`connector:read`) — `create`, `delete`, `docs-delete`, `docs-ingest`, `docs-list`, `docs-search`, `get`, `inspect`, `list`, `patch`, `probe`, `test`.
- `sk connector-templates` (`connector:read`) — `create`, `delete`, `list`, `recipe`, `recipe-pack`, `recipes`, `search`, `set-oauth`.
- `sk credentials` (`credential:read`) — `delete`, `list`, `rotate`, `set`.
- `sk auth` (`connector:write`) — start a connector reauthentication flow (OAuth2 authorize URL).
- `sk install` (`connector:write`) — guided enterprise integration setup: `github`, `google-workspace`, `hubspot`, `jira`, `salesforce`, `slack`, `teams`.
- `sk mcp-servers` (`mcp_server:manage`) — manage external MCP servers: `add`, `authorize`, `disable`, `enable`, `get`, `inspect`, `list`, `remove`, `set-credential`.
- `sk executions` (`execution:read`) — `abort`, `get`, `list`, `rerun`, `result`, `steps`, `tail`.
- `sk schedules` (`workflow:read`) — `list`.
- `sk knowledge-sources` (`knowledge:read`) — `analyze`, `create`, `delete`, `get`, `list`, `patch`, `search`.
- `sk skills` (`skill:read`) — `activate`, `archive`, `create`, `delete`, `edit`, `get`, `history`, `list`, `patch`, `restore`.
- `sk discovery` (`discovery:read`) — `approve`, `artifacts`, `create`, `get`, `list`, `reject`.
- `sk hooks` (`inbound_hook:read`) — inbound webhook bindings: `create`, `delete`, `get`, `list`.
- `sk subscriptions` (`subscription:read`) — event subscriptions: `create`, `delete`, `deliveries`, `get`, `list`, `patch`, `replay`.
- `sk events` (`audit:read`) — audit events: `get`, `list`.
- `sk notifications` (`notification:read`) — `channels`, `deliveries`, `inbox`, `rules`.
- `sk stats` (`stats:read`) — tenant-scoped runtime statistics: `connectors`, `events`, `executions`, `llm`.

# Self-Healing, Review, Candidates

- `sk self-healing` (`workflow:write`, admin) — trigger and review proactive drift scans: `list`, `scan`, `show`.
- `sk patch-candidates` (`workflow:read`) — manage workflow patch candidates: `approve`, `get`, `list`, `reject`.
- `sk skill-candidates` (`skill:read`) — manage proposed skill candidates: `approve`, `get`, `list`, `reject`.
- `sk review` (`workflow:read`) — aggregated approval digest: pending patch candidates, proposed skill candidates, and recent failed executions.

# Coding-Agent Integration: sk agent, sk learnings, sk skills sync

These commands connect external coding agents (Claude Code, Codex) to the engine's domain knowledge. A repo declares its domains in `.sk/agent.json` (`{"domains": ["<slug>"]}`); domains are the tag convention `domain:<slug>` on Skills and Knowledge Sources.

- `sk agent init --domains <a,b>` (`skill:read`) — writes `.sk/agent.json`, idempotently wires the Claude Code hooks in `~/.claude/settings.json` (SessionStart → briefing injection incl. re-injection after compaction; SessionEnd → transcript capture), and prints the Codex hook snippets plus the MCP registration commands for both agents.
- `sk agent briefing` — prints the domain-scoped session briefing (active domain skills, knowledge index, search-first grounding rule) fetched from `GET /v1/agent/briefing`. `--hook` is the SessionStart-hook mode: reads the hook JSON from stdin, resolves `.sk/agent.json` from the session cwd, and NEVER fails the session — errors degrade to empty output + exit 0 and land in `~/.sk/debug.log`. `--domains` and `--budget` override the repo declaration.
- `sk agent capture` — posts a session transcript to `POST /v1/agent/sessions` for learning distillation. `--hook` is the SessionEnd/Stop-hook mode (transcript path from the hook payload, silent-fail); manual use takes `--transcript <path>` plus optional `--agent`, `--session-id`, `--domains`. Captures only in repos with declared domains. Distillation extracts ONLY durable, human-taught rules; results are `session_learning` skill candidates — never live knowledge.
- `sk learnings` (`skill:read`; approve/reject enforce `skill:write` server-side) — the human curation gate: `list` shows proposed session learnings, `review` walks them interactively (approve → ACTIVE domain-tagged skill that the next briefing carries; edit-then-approve; reject retires the learning's fingerprint for good; skip).
- `sk skills sync` — materializes the repo's active domain skills as Agent-Skills-standard `SKILL.md` directories into `.claude/skills/` and `.agents/skills/`. Only directories carrying the sk managed-marker are created, updated, or pruned; hand-authored skills are never touched. Idempotent; re-run after approving learnings.

# Files, Extract, Attach

- `sk files` (`file:read`) — manage files: `delete`, `download`, `get`, `link`, `list`, `stats`, `upload`.
- `sk attach` (`file:write`) — shortcut to upload a file and link it to a conversation.
- `sk extract` (`conversation:write`) — extract structured data from a file (LLM for text, native parsers for binary).

# Admin Commands

- `sk rbac` (`rbac:read`) — roles, permissions, grants, groups, hooks: `can`, `grants`, `groups`, `permissions`, `request-hooks`, `roles`, `users`, `whatcan`.
- `sk audit` (`audit:read`) — append-only audit log: `export`, `query`, `show`, `tail`.
- `sk apikeys` (`api_key:read`) — `create`, `list`, `revoke`, `rotate`.
- `sk portal-tokens` (`portal_token:read`) — `create`, `list`, `revoke`.
- `sk users` (`identity:read`) — `create`, `delete`, `get`, `invite`, `list`, `patch`.
- `sk system-accounts` (`identity:read`) — `create`, `delete`, `list`.

# Maintenance

`sk update` — update the sk CLI to the latest version. The `--help` of any command (e.g. `sk workflows --help`) lists its flags and subcommands. Many resource commands accept `--json` for machine-readable output and resolve a connector/workflow by id, slug, name, or display_name.
