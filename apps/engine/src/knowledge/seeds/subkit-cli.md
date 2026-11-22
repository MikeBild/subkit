---
slug: sk-ref-cli
name: subkit Platform Reference — subkit CLI
description: Exhaustive reference for the subkit command-line client — every top-level command, headless mode, profiles, the subkit mcp stdio proxy, settings, bootstrap flows, and the coding-agent integration commands (agent, learnings, skills sync).
tags: [sk-platform-reference, cli, subkit-cli, headless, profiles, mcp, settings, bootstrap]
scope: global
version: 5
---

# subkit CLI Overview

`subkit` is the command-line client for a subkit engine. Bare `subkit` opens an interactive REPL (Ink rich UI on a TTY, line-based readline when stdout is piped). Every subcommand is scriptable, prints to stdout, and accepts `--help`. The engine enforces RBAC on every API call; the CLI's persona-aware `--help` filtering is visibility-only and never a security boundary.

Two usage shapes:
- Conversational: `subkit` (REPL) or `subkit -p "<prompt>"` (headless) drive a guided conversation that authors, refines, runs, and commits workflows.
- Direct resource management: `subkit workflows`, `subkit connectors`, `subkit executions`, `subkit rbac`, etc. operate on engine resources without a conversation.

State lives under `~/.subkit/`: `config.json` (profiles), `settings.json` (CLI settings), `sessions/` (cached conversation metadata), `debug.log` and `history.jsonl` (diagnostics).

# Installing / accessing the CLI

Install `subkit` with a single shell one-liner — there is no package-manager step. The engine you are already talking to serves an installer pinned to its own version, so the CLI matches it. Where `<engine-url>` is that engine's base URL (the same base URL this chat/API runs on):

```
curl -fsSL <engine-url>/install | bash
```

Without access to an engine, install the latest release:

```
curl -fsSL https://github.com/MikeBild/subkit/releases/latest/download/install.sh | bash
```

The script detects the platform (macOS on Apple silicon, Linux x64 and arm64, Windows x64 under Git Bash), downloads the matching release file `subkit-<os>-<arch>`, verifies it against `SHA256SUMS` (and the release signature when OpenSSL 3 is available) and installs it to `~/.local/bin`. `SUBKIT_INSTALL_DIR` picks another folder, `SUBKIT_VERSION` pins a version. After installing, point `subkit` at an engine and authenticate with `subkit login` / `subkit profile` (see below), or bootstrap a fresh engine with `subkit init`.

Keep the CLI current with `subkit update` (latest release, `--check` only reports) or align it with the engine of the active profile with `subkit update --match-engine`. Once a day `subkit` prints a one-line hint when a newer release exists; `"updateCheck": false` in `~/.subkit/settings.json` switches that off. When the CLI and the engine differ in their minor or major version, `subkit` warns and names `subkit update --match-engine`.

These are the only supported ways to get the CLI. Concretely, `subkit` is **not** published on npm — do not run `npm install` or `npx` to get it; no such package exists. There is **no** other download page, **no** `docker-compose` step to install the CLI, and no `subkit login <url>`-as-installer step; `docker compose` runs the engine, not the CLI.

# Global Flags and Profile Resolution

Common flags accepted by most commands:
- `--engine-url <url>` — engine base URL (default `http://localhost:3000`).
- `--api-key <key>` — API key, sent as `Authorization: Bearer <key>`.
- `--tenant <id>` — active tenant id.
- `--profile <name>` — named profile from `~/.subkit/config.json`.

Resolution precedence (highest first):
1. CLI flags (`--engine-url`, `--api-key`, `--tenant`, `--profile`).
2. Environment: `SUBKIT_ENGINE_URL`, `SUBKIT_API_KEY`, `SUBKIT_TENANT`, `SUBKIT_PROFILE`.
3. On-disk fields from the selected profile.
4. Defaults.

Configuration is done with `subkit settings` / `subkit config set` (engine settings) and `subkit profile` / `subkit login` (local profiles). Never use `SUBKIT_OVERRIDE_*` environment variables to configure the engine — they are not a supported path; set engine settings through `subkit settings set` instead.

# Profiles and ~/.subkit/config.json

`~/.subkit/config.json` holds multiple named profiles plus an `active_profile`. Shape:
```
{ "active_profile": "default", "profiles": { "default": { "engine_url", "api_key", "active_tenant_id", "persona_hint?", "portal_locked?", "notification_inbox_cursor?" } } }
```
The file is written `0600`. A signed-out profile drops `api_key` entirely (rather than persisting an empty string). The default profile name is `default`; the default engine URL is `http://localhost:3000`.

`subkit profile` manages named profiles (environments): subcommands `add`, `delete`, `list`, `show`, `use`. Switch the active profile with `subkit profile use <name>` or per-invocation with `--profile <name>`. At REPL runtime `/profile` opens the profile palette and `/tenant` switches tenant.

# Authentication: login, logout, status, tenants

`subkit login` — authenticate against an engine and save the profile. Flags select the method:
- `--api-key <key>` — scripted API-key login (skips device flow).
- `--portal-token <token>` — authenticate as a portal-token principal (locks the profile to `portal_locked`).
- `--client-id`, `--scope` — client metadata for a configured OIDC device-flow adapter; the issuer and provider id always come from engine discovery.
- With no `--api-key`, login discovers a configured direct OIDC adapter and uses its device flow.

`subkit logout` — drop the active profile's credentials.

`subkit status` — print the active profile and engine reachability.

`subkit tenants` — list tenants you belong to, or switch the active one.

On a bare `subkit` with no usable profile on a TTY, an onboarding picker offers: browser login, paste API key, point-at-engine / bootstrap (`subkit init`), or device-code flow. Non-TTY callers instead get `subkit: not logged in` on stderr and exit 2.

# Bootstrap: subkit init and subkit join

`subkit init` — complete first-run engine bootstrap. Consumes the one-time token printed in the engine's first-boot startup banner. Flags: `--token <token>` (auto-detected from `SUBKIT_BOOTSTRAP_TOKEN_FILE` on the all-in-one Docker image), `--engine-url`, `--profile`, `--admin-email`, `--tenant-name`, `--llm-provider`, `--llm-api-key`. When admin-email, tenant-name, llm-provider, and llm-api-key are all supplied it runs fully headless; otherwise it prompts for the missing fields. Saves the resulting admin API key into the profile.

`subkit join` — redeem a single-use invite token to provision your personal API key (no login required). Flags: `--token <token>` (from your admin), `--engine-url`, `--profile`. Writes the new key into the named profile.

`subkit invites` (admin, `identity:read`) manages the invites these redeem: `list`, `revoke`.

# Headless Mode (subkit -p)

`subkit -p "<prompt>"` runs a single conversation turn end-to-end and prints the result, then exits. Flags:
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

Bare `subkit` (optionally `subkit "<initial prompt>"`, `subkit -c`, `subkit -r <id>`) opens the REPL. In-REPL slash commands (local = handled client-side; others call the engine):

Session/authoring: `/clear`, `/compact`, `/resume`, `/fork`, `/rename`, `/draft`, `/connector`, `/workflow`, `/context`, `/templates`, `/probe`, `/preview`, `/versions`, `/restore <version>`, `/onboard`, `/setup`.
Approvals/policy: `/approvals`, `/approve`, `/reject`, `/policy <tool> <auto|ask|review|reset>`, `/permissions`.
Status/usage: `/status`, `/cost`, `/usage`, `/exec [execution_id]`, `/verbose`, `/model`, `/queue`, `/history`.
Identity: `/login`, `/logout`, `/profile [name]`, `/tenant`.
Context/files: `/memory` (open `SK.md` in `$EDITOR`), `/init` (generate a starter `SK.md`), `/files`, `/paste`, `/mention`, `/copy`, `/export`, `/view chat|inspect`. In the interactive REPL, pasted or dropped local file paths are handled directly by the composer; do not route users to `/attach` or `/upload`.
Discovery: `/skills`, `/knowledge`, `/mcp`, `/connectors`, `/workflows`, `/executions`.
Admin/config: `/config`, `/config-form`, `/settings` (5-tab palette: Status / Config / Usage / Skills / Knowledge), `/admin`, `/audit`, `/logs [limit] [trace_id]`, `/debug on|off|tail`, `/session <workflow-id>` (mint a short-lived portal token + QR code), `/actions`, `/feedback`, `/help`, `/exit`.

# subkit mcp — stdio MCP Proxy

## Collected pages and ideas

`subkit intake list` lists collected items in the personal default category. `subkit intake list --category research`
lists that shared category's new entries. `subkit intake review --category research`
starts a saved review conversation and prints the authenticated Cockpit link.
Without a selection, review uses the caller's default category; it never
silently selects all tenant entries. `--items <comma-separated-ids>` selects
particular clips, and `--json` returns structured output. The reviewer sees
sources, proposed text and destination before confirming in the Cockpit.
The CLI and MCP proxy preserve `intake_item_ids` as structured conversation input.
Use `subkit intake default --category research`, `subkit intake move --item <id> --category research`,
`subkit intake discard --item <id>`, or `subkit intake restore --item <id>` for reversible organization.
Item changes check the current version; a concurrent change is reported without overwriting it.
These commands never confirm an admission as knowledge or a skill.
They do not expose an intake-confirmation tool.

`subkit mcp` runs a stdio Model Context Protocol server that proxies the most-used conversation surfaces to the engine, so an IDE/MCP client can drive subkit without the TUI. It requires a logged-in profile (else `subkit mcp: not logged in` / exit 2). It authenticates with the resolved profile — i.e. `--api-key`/`--engine-url` flags, the `SUBKIT_API_KEY`/`SUBKIT_ENGINE_URL` environment variables, or the on-disk profile — not any `SK_*`-named variable. (`SUBKIT_API_KEY` appears only as a placeholder in the curl/python snippets `subkit workflows invoke-snippet` generates for your own scripts; the CLI itself does not read it. The snippet always states where the call runs: `--environment prod` (the default) or `--environment dev` is printed as the `x-subkit-environment` header, because a call without that header runs in development.)

The proxy exposes a small local toolset that forwards to engine HTTP endpoints: ping the engine, create a conversation, append a message, fetch a conversation, and list your conversations. This stdio proxy is distinct from the engine's own remote MCP server: the engine's MCP palette (reached over HTTP at the engine URL by clients like claude.ai/ChatGPT) uses underscore tool names — `wf_<slug>`, `conversation_start`, `conversation_append`, `conversation_get`, `conversation_commit`, `conversation_respond_elicitation`, `run_workflow`, `search_knowledge`, `list_knowledge_sources`, `get_engine_status`, `whoami`, `get_ai_budget`, `get_llm_usage`, `list_inbound_hooks`, `get_inbound_hook` — never dotted.

# subkit settings — Engine Settings

`subkit settings` lists, reads, writes, or interactively configures engine settings; secrets are always returned masked by the engine and never printed raw. Subcommands:
- `list` — every leaf with its resolved value, source (`default`/override), `secret`/`restart` flags, plus pending-restart and active-override diagnostics.
- `get <path>` — read one leaf by dotted path (e.g. `llm.api_key`), showing value, kind, scope/source, sensitivity, restart requirement, description.
- `set <path> <json>` — write one leaf; `<value>` must be valid JSON (`'"abc"'`, `42`, `true`, `null`). `--force` bypasses the `requiresRestart` guard in production.
- `configure` — interactive Ink palette (tabs: Status / Config / Usage / Skills / Knowledge); `--non-interactive` (auto-detected off a TTY) prints the `GET /v1/settings` payload as JSON instead.

All subcommands accept `--tenant <id>` to write a tenant overlay (only `scope: "tenant"` leaves are writable per tenant). This is the canonical way to configure the engine — prefer it over any environment-variable override.

`subkit config set ...` is the equivalent settings-write entry surfaced in conversational guidance; engine settings are never set via `SUBKIT_OVERRIDE_*` env vars.

## CLI Settings (~/.subkit/settings.json)

Distinct from engine settings, the CLI reads layered JSON (later wins): `~/.subkit/settings.json` (user) → `<repo>/.subkit/settings.json` (project, walked upward) → `<cwd>/.subkit/settings.local.json` (local, git-ignored). Keys: `model`, `defaultTenant`, `additionalDirectories`, `statusLine` (`command`/`format`/`showCost`/`showTokens`/`showPersona`/`refreshMs`), `mcpServers`, `includeMemoryFile` (default true), `maxInlineMentionBytes` (default 262144), `headless` (`maxTurns`/`maxBudgetTokens`), `nextCommandPreviewEnabled` (default true). Unknown keys are preserved.

# Sessions: ls, show, rename, rm, sessions

Conversation sessions are cached locally in `~/.subkit/sessions/` so `-c`/`-r` and aliases work without a round-trip; the server-side conversation row is independent.
- `subkit ls` — list cached sessions for the active profile.
- `subkit show <id|alias>` — show cached metadata for a session.
- `subkit rename <id> <alias>` — assign/change a short alias used by `subkit -r <alias>`.
- `subkit rm <id>` — drop a session from the local cache (server-side row preserved).
- `subkit sessions` — manage cached sessions with subcommands `ls`, `rename`, `rm`, `search`, `show`.

# Health, Doctor, Diagnostics, Logs

`subkit health` — runtime posture: liveness, AI budget, failing runs, risk signals, schema drift, process runtime.

`subkit doctor` — diagnose engine connectivity, authentication, and setup. Exits `0` (ok or warn) or `2` (blocked). Use `subkit doctor` for connectivity/setup; `subkit health` for runtime posture.

`subkit diagnostics` (`audit:read`) — engine diagnostics with subcommands `errors`, `llm`, `setup`.

`subkit logs` (`audit:read`) — tail the engine runtime log ring. `--follow` streams via SSE; `--since` accepts `5m`/`2h`/`1d`/ISO-8601.

# Resource Commands (Operator)

- `subkit workflows` (`workflow:read`) — `create`, `delete`, `dry-run`, `get`, `history`, `invoke-snippet`, `list`, `preview`, `restore`, `run`, `validate`.
- `subkit connectors` (`connector:read`) — `list`, `get`, `inspect`, `create`, `import`, `validate`, `patch`, `enable`, `disable`, `mcp-inspect`, `mcp-authorize`, `delete`, `promote`, `test`, `probe`, `docs-ingest`, `docs-list`, `docs-search`, `docs-delete`. `create --file` validates and probes the unsaved definition before creating it (`--skip-checks` bypasses), `patch --file` applies a partial definition and validates first, `validate <file>` checks a definition against its driver's config schema without saving or reaching upstream, and `import --spec` turns an API specification into a connector after showing the draft. `enable` / `disable` are the driver-agnostic on/off switch. This is also where external MCP servers live: they are connectors with `driver: "mcp"`, so `mcp-inspect` forces a handshake and lists the tools, capabilities and instructions the remote actually serves, and `mcp-authorize` prints the OAuth 2.1 URL to open in a browser. There is no `subkit mcp-servers` command — that registry was removed, and `/mcp-servers` in the REPL now answers with a pointer to `/connectors`.
- `subkit connector-templates` (`connector:read`) — `create`, `delete`, `list`, `recipe`, `recipe-pack`, `recipes`, `search`, `set-oauth`.
- `subkit vault` — `list`, `show`, `add`, `rotate`, `reveal`, `refresh`, `rm`, `attach`, `connector`. Values come from stdin; `reveal` needs `--yes` and is audited.
- `subkit auth` (`connector:write`) — start a connector reauthentication flow (OAuth2 authorize URL).
- `subkit install` (`connector:write`) — guided enterprise integration setup: `github`, `google-workspace`, `hubspot`, `jira`, `salesforce`, `slack`, `teams`.
- `subkit executions` (`execution:read`) — `abort`, `get`, `list`, `rerun`, `result`, `steps`, `tail`.
- `subkit schedules` (`workflow:read`) — `list`.
- `subkit knowledge-sources` (`knowledge:read`) — `analyze`, `create`, `delete`, `get`, `list`, `patch`, `search`.
- `subkit skills` (`skill:read`) — `activate`, `archive`, `create`, `delete`, `edit`, `get`, `history`, `list`, `patch`, `restore`.
- `subkit discovery` (`discovery:read`) — `approve`, `artifacts`, `create`, `get`, `list`, `reject`.
- `subkit hooks` (`inbound_hook:read`) — inbound webhook bindings: `create`, `delete`, `get`, `list`.
- `subkit subscriptions` (`subscription:read`) — event subscriptions: `create`, `delete`, `deliveries`, `get`, `list`, `patch`, `replay`.
- `subkit events` (`audit:read`) — audit events: `get`, `list`.
- `subkit notifications` (`notification:read`) — `channels`, `deliveries`, `inbox`, `rules`.
- `subkit stats` (`stats:read`) — tenant-scoped runtime statistics: `connectors`, `events`, `executions`, `llm`.

# Self-Healing, Review, Candidates

- `subkit self-healing` (`workflow:write`, admin) — trigger and review proactive drift scans: `list`, `scan`, `show`.
- `subkit patch-candidates` (`workflow:read`) — manage workflow patch candidates: `approve`, `get`, `list`, `reject`.
- `subkit skill-candidates` (`skill:read`) — manage skill proposals the engine detected from recurring patterns: `approve`, `get`, `list`, `reject`. Session learnings are not candidates; they are collected in Intake (`subkit intake list`).
- `subkit review` (`workflow:read`) — aggregated approval digest: pending patch candidates, proposed skill candidates, and recent failed executions.

# Coding-Agent Integration: subkit agent, subkit intake, subkit skills sync

These commands connect external coding agents (Claude Code, Codex) to the engine's domain knowledge. A repo can declare its domains in `.subkit/agent.json` (`{"domains": ["<slug>"]}`). Without a declaration, briefing hooks match the normalized current-folder name exactly against readable catalog categories. A unique project match creates an inferred declaration with shared SubKit context when available; otherwise a shared-only inferred declaration is created when possible, and the agent asks which project area, sources, and workflows belong there when setup is relevant. Inferred declarations keep checking the folder name as catalog categories change. Domain tags `domain:<slug>` are supported on Skills and Knowledge Sources; categories can also come from workflows, connectors, and ready files. Briefings show only readable file metadata, never file contents.

- `subkit agent init --domains <a,b>` (`skill:read`) — merges requested domains into `.subkit/agent.json` without deleting existing domains or settings, wires Claude Code and Codex briefing hooks plus SessionEnd transcript capture in both clients, then prints what stays manual for Codex (hooks are enabled by default; review and trust the subkit hooks under `/hooks`) plus the MCP registration commands for both agents. Codex capture uses a detached process to fit the three-second hook limit. `--skip-claude` / `--skip-codex` leave the respective file alone. Hook and REPL briefings share an 1,800-token budget and 9,500-character hard limit. A domain is a catalog category or a `domain:<slug>` tag; everything in that category is briefed.
- `subkit agent briefing` — prints the domain-scoped session briefing (active domain skills, knowledge index, readable workflow, connector and file metadata, search-first grounding rule) fetched from `GET /v1/agent/briefing`. `--hook` reads hook JSON from stdin, uses `.subkit/agent.json` when present or resolves the current folder name against readable catalog categories, adds shared SubKit context when available, and NEVER fails the session — errors degrade to a brief warning + exit 0 and land in `~/.subkit/debug.log`. `--domains` and `--budget` override the repo declaration.
- `subkit agent capture` — posts a session transcript to `POST /v1/agent/sessions` for learning distillation. `--hook` is the SessionEnd-hook mode (transcript path from the hook payload, silent-fail); `--detach` queues capture asynchronously for clients with short hook deadlines. Manual use takes `--transcript <path>` plus optional `--agent`, `--session-id`, `--domains`. Captures only in repos with declared domains. Distillation extracts ONLY durable, human-taught practices and facts (events, status updates and anything credential-related are dropped); each lands as an Intake item with origin `session` in the domain's shared category, or the collector's default category — never as knowledge or a skill. A manual run prints where to review the collected items in the Cockpit.
- `subkit intake list` / `subkit intake review` — the review path for session learnings: `list` shows collected items with their origin (`capture` or `session`), `review` starts a saved review conversation and prints the Cockpit link. A person confirms the proposal in the Cockpit, which publishes it as domain knowledge or as an ACTIVE skill that the next briefing carries; replaced skills are archived in the same step.
- `subkit skills sync` — materializes the repo's active domain skills as Agent-Skills-standard `SKILL.md` directories into `.claude/skills/` and `.agents/skills/`. Only directories carrying the subkit managed-marker are created, updated, or pruned; hand-authored skills are never touched. Idempotent; re-run after confirming a skill proposal.

# Files, Extract, Attach

- `subkit files` (`file:read`) — manage files: `delete`, `download`, `get`, `link`, `list`, `stats`, `upload`.
- `subkit attach` (`file:write`) — shortcut to upload a file and link it to a conversation.
- `subkit extract` (`conversation:write`) — extract structured data from a file (LLM for text, native parsers for binary).

# Admin Commands

- `subkit rbac` (`rbac:read`) — roles, permissions, grants, groups, hooks: `can`, `grants`, `groups`, `permissions`, `request-hooks`, `roles`, `users`, `whatcan`.
- `subkit audit` (`audit:read`) — append-only audit log: `export`, `query`, `show`, `tail`.
- `subkit apikeys` (`api_key:read`) — `create`, `list`, `revoke`, `rotate`.
- `subkit portal-tokens` (`portal_token:read`) — `create`, `list`, `revoke`.
- `subkit users` (`identity:read`) — `create`, `delete`, `get`, `invite`, `list`, `patch`.
- `subkit system-accounts` (`identity:read`) — `create`, `delete`, `list`.

# Maintenance

`subkit update` — update the subkit CLI to the latest version. The `--help` of any command (e.g. `subkit workflows --help`) lists its flags and subcommands. Many resource commands accept `--json` for machine-readable output and resolve a connector/workflow by id, slug, name, or display_name.
