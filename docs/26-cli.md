# 26 — The `sk` CLI

The engine ships a single unified CLI binary: **`sk`** (`apps/sk`).

`sk` is persona-aware. After login the engine's RBAC probes determine which commands and slash commands are visible:

| Persona | Surfaces visible |
|---|---|
| `enduser` / `portal` | REPL, `/help`, login/logout/profile/status/tenants/sessions/health |
| `member` | + `/skills`, `/knowledge`, `/mcp`, `skills`, `knowledge-sources` commands |
| `operator` | + all workflow/connector/execution/notification/install commands and REPL slash commands |
| `admin` | + RBAC, audit, API keys, portal tokens, users, system-accounts, diagnostics |

The binary compiles standalone via `bun build --compile` and talks to the engine through a hand-written typed client (`apps/sk/src/engine-client.ts`) to keep the compiled size tight.

See `docs/27-sk-cli.md` for the full REPL + persona design.

## Stack

| Concern | Library |
|---|---|
| Command parsing and routing | `citty` |
| Interactive prompts | `@clack/prompts` |
| Colors | `picocolors` |
| Interactive REPL TUI | `ink` + `ink-markdown` (lazy-imported, never loaded for scripting commands) |
| Shared auth / updater / turn events | `packages/cli-core/` |
| Output formatting | `@cli-core/format` (`emitList`, `printJson`, `printTable`) |

## Talking to the engine

`sk` defaults to `http://localhost:3000`. Precedence (highest wins):

1. `--engine-url` flag
2. `SUBKIT_ENGINE_URL` env var
3. Active profile in `~/.sk/config.json`
4. Built-in default

Auth follows the same precedence with `--api-key` / `SUBKIT_API_KEY`. Use `sk profile` to manage named profiles.

## Full command surface

```
# All personas
sk login | logout | profile | status | tenants | health | sessions | update | mcp

# Member+
sk skills list | get | create | patch | activate | archive | delete
sk skill-candidates list | get | approve | reject
sk knowledge-sources list | get | search | create | patch | delete

# Operator+
sk workflows list | get | run | delete | history | restore | create
sk connectors list | get | create | patch | delete | test | docs-ingest | docs-list | docs-search | docs-delete
sk connector-templates list | create | delete
sk credentials list | rotate | delete
sk discovery list | get | artifacts | approve | reject | create
sk executions list | get | steps | abort | tail
sk patch-candidates list | get | approve | reject
sk hooks list | get | create | delete
sk subscriptions list | get | create | patch | delete | deliveries | replay
sk tunnels list | get | create | delete
sk notifications channels list | get | create | update | delete
sk notifications rules list | get | create | update | delete
sk notifications deliveries list
sk extract --sample <text>
sk install slack | teams | github | google-workspace | salesforce | jira | hubspot

# Admin+
sk rbac permissions list
sk rbac roles list | get | create | delete | grant | revoke
sk rbac users assign
sk rbac grants list | create | delete
sk rbac groups list | create | delete | add-member | remove-member | assign-role
sk rbac can <permission>
sk rbac request-hooks list | create | delete
sk audit query | show | export | tail
sk events list | get
sk apikeys list | create | rotate | revoke
sk portal-tokens list | create | revoke
sk users list | get | patch | delete
sk system-accounts list | create | delete
sk diagnostics errors | llm | setup
```

## REPL slash commands

The interactive REPL (`sk` with no args) adds slash commands. Visibility is gated by persona:

```
# All personas
/help  /clear  /status  /cost  /profile  /login  /logout
/resume  /model  /memory  /init  /config  /permissions  /debug
/paste  /attach  /queue  /history  /view  /exit

# Member+
/skills  /knowledge  /mcp

# Operator+
/connectors  /workflows  /executions  /patch-candidates
/notifications  /tunnels  /discovery
/install-slack  /install-teams  /install-github
/install-google-workspace  /install-salesforce  /install-jira  /install-hubspot

# Admin+
/audit  /logs  /apikeys  /users  /system-accounts
```

## Output conventions

- Default: human-readable tab-separated columns, ANSI colors when stdout is a TTY.
- `--json` flag: JSON output for every command, suitable for `jq` / CI scripts.
- Errors → stderr; data → stdout. Exit 0 = success, 1 = recoverable, 2 = transport/auth failure.

## What `sk` does not do

- No client-side caching — every command is a fresh round trip.
- No background daemons — exits cleanly after every invocation except the REPL.
- No engine-resident state — profiles live in `~/.sk/config.json`.
- No command synthesis — every subcommand maps 1:1 to a REST or SSE endpoint.
