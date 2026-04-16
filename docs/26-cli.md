# 26 — The `subkit` and `sk` CLIs

The engine ships two first-class end-user surfaces:

| Binary | Package | Purpose |
|---|---|---|
| `subkit` | `apps/cli` | Operator CLI — noun-verb commands (`subkit workflows list`, `subkit connectors test`, `subkit chat`). Used by engineers, CI, and ops dashboards. |
| `sk` | `apps/sk` | End-user CLI modeled after Claude Code / Codex CLI — persona-aware interactive surface (REPL, slash commands, `@` mentions, `SUBKIT.md` memory, headless `-p` mode). Used by admins, members, endusers, and portal-token customers. |

Both binaries compile standalone via `bun build --compile` and share the same backend API surface. Both reach the engine through a hand-written typed client (see `apps/*/src/engine-client.ts`) to keep their compiled size tight.

See `docs/27-sk-cli.md` for the `sk` binary design, the four persona stories, and the slash-command catalogue. The remainder of this document describes `subkit` — the operator CLI.

## Stack

| Concern | Library | Trade-off |
|---|---|---|
| Command parsing and routing | `citty` | Tiny, declarative command tree; the alternative (`commander`) carries more API surface than the CLI needs. |
| Interactive prompts | `@clack/prompts` | Modern prompt UX without the ceremony of `inquirer`; the cost is fewer prompt widgets, all of which the CLI uses. |
| Colors | `picocolors` | Minimal, no `chalk` v5 ESM-only constraints; loses fancy styling features none of the commands need. |
| Conversational UI (`subkit chat` only) | `ink` + `ink-markdown` | React-style terminal UI for streaming markdown and live panels; pulled in only on `chat` so the rest of the CLI starts instantly. |
| HTTP and SSE | `hono/client` | Compile-time type safety against the engine's route exports; the cost is a same-repo TypeScript dependency, which is exactly what the CLI is. |

The CLI never imports a generated client — it consumes the engine's `AppType` export through `hono/client` and gets every endpoint's request and response shape checked at build time.

## Talking to the engine

The CLI talks to a **local engine by default** at `http://localhost:3000`. The base URL is overridable in four ways, evaluated in order: a `--engine-url` flag on the command, a `SUBKIT_ENGINE_URL` environment variable, the `engine_url` field of the active profile in `~/.subkit/config.json`, and the built-in default. Authentication follows the same precedence: a `--api-key` flag wins over `SUBKIT_API_KEY` which wins over the active profile's stored key. Use `subkit profile` to manage named profiles for different environments (local, staging, production).

Trade-off: defaulting to localhost makes the "I just compiled the engine and want to poke at it" path zero-config, while still letting an operator point the CLI at a remote engine without changing the command surface.

## Full command surface

```
subkit login                              # OIDC device flow
subkit tenants use <tenant>

subkit workflows list | get | run | delete | export | import | history | restore
subkit connectors list | create | test | docs ingest | docs search
subkit credentials list | rotate
subkit schedules list | create | pause | resume
subkit skills list | create | edit | activate | archive
subkit executions list | get | logs | abort | replay
subkit executions tail <id>
subkit hooks inbound list | create | test
subkit subscriptions list | create | deliveries | replay
subkit events tail
subkit notifications rules list | create | test
subkit notifications channels list | create
subkit tunnels list | create
subkit tunnel-agent run
subkit apikeys list | create | rotate | revoke
subkit portal-tokens list | create | revoke
subkit extract <file>
subkit chat                               # conversational authoring
subkit mcp                                # stdio MCP server pointed at a remote engine
```

Notes on the less-obvious entries:

- **`subkit login`** — runs an OIDC device flow against the engine's `oidc` provider. The engine prints a URL and a code; the CLI polls until the user completes the browser flow, then stores the resulting session in the active profile.
- **`subkit tenants use <tenant>`** — switches the active tenant inside the current profile. A user who belongs to several tenants can switch without re-authenticating.
- **`subkit executions tail <id>`** — opens an SSE stream against `/v1/executions/:id/stream` and prints frames live.
- **`subkit events tail`** — opens an SSE stream against `/v1/events/stream`. Optional `--pattern` filter.
- **`subkit tunnel-agent run`** — the **companion binary**. Same codebase as the CLI, separate `bun build --compile --target ...` build target. Opens the persistent outbound WebSocket and registers the agent's targets with the engine.
- **`subkit mcp`** — runs an MCP server over stdio that proxies into the configured engine. IDE plugins and other MCP clients launch this command to talk to a remote engine through a local stdio transport.
- **`subkit extract <file>`** — pipes a file through `/v1/extract` and prints the structured JSON to stdout.

## `subkit chat` UX checklist

The chat command is the heaviest surface in the CLI. It is the conversational authoring loop projected into a terminal pane.

1. **Streaming markdown rendering of LLM turns.** Each assistant turn streams in token-by-token through `ink-markdown`, which re-flows on every chunk. Headings, code blocks, and inline emphasis all render live.
2. **Tool-call panels.** The structured-intent tools (`propose_step`, `update_param`, `connect_steps`, `dry_run_step`, `validate_draft`, `request_human_approval`, `commit_draft`, etc.) render as collapsible panels showing the tool name, arguments, live status (running, succeeded, failed), and result preview.
3. **Inline approval prompts.** When the loop calls `request_human_approval`, the chat surface pauses, renders a compact diff of the pending change, and shows an inline `Approve / Reject` selector. Decisions are POSTed back to `/v1/conversations/:id/approvals`, and the loop resumes.
4. **Live draft view side panel.** The right-hand panel renders the current Workflow draft as a JSON document, with the most recent change highlighted. The side panel updates as the loop mutates the draft.
5. **Context display.** A status line shows the active tenant, the in-scope Skills, the active Connector if any, and the estimated remaining token budget against the tenant's monthly LLM quota.
6. **Resumable.** `subkit chat --resume <conversation-id>` reattaches to an existing Conversation. The chat loop replays the full history from the server (the same machinery that `21-run-search.md` uses) and continues from the last frame.
7. **Undo / reset / skills slash-commands.** Inside the chat session the user can type `:undo` (revert the last draft mutation), `:reset` (start a new draft on the same Conversation), or `:skills` (list Skills currently in scope). Slash-commands are local to the chat surface; they do not collide with the chat platform `/subkit ...` slash commands.
8. **Cancel.** Ctrl-C sends an MCP cancellation through the Conversation's tool channel. In-flight tool calls unwind at their next safe point and the chat surface returns control to the user.
9. **Replay-safe.** Every message and every tool call is persisted server-side in `conversation_messages` and `conversation_tool_calls`. A crashed CLI client never loses state — `--resume` brings the user back exactly where they were.

Trade-off: the chat surface is materially heavier than the rest of the CLI. It is the only command that loads `ink` and `ink-markdown`. The CLI binary lazy-imports those modules so a user running `subkit workflows list` never pays the cost.

## Typed `hono/client` call pattern

Every command that touches the engine builds a single typed client and calls one or more route methods. There is no global state and no implicit request building.

```ts
import { hc } from "hono/client";
import type { AppType } from "../shared/route-types";

type Profile = { engine_url: string; tenant: string; api_key: string };

function makeClient(profile: Profile) {
  return hc<AppType>(profile.engine_url, {
    headers: {
      Authorization: `Bearer ${profile.api_key}`,
      "x-subkit-tenant": profile.tenant,
    },
  });
}

// Implementation of `subkit workflows list --limit 100`.
export async function workflowsList(profile: Profile, limit: number) {
  const client = makeClient(profile);
  const res = await client.v1.workflows.$get({ query: { limit } });
  if (!res.ok) throw new Error(`engine error: ${res.status}`);
  const body = await res.json();
  // body is { data: WorkflowSummary[]; total: number; has_more: boolean }
  for (const w of body.data) {
    console.log(`${w.slug}\tv${w.current_version}\t${w.name}`);
  }
}
```

The same `hc<AppType>(...)` instance covers list, get, run, history, restore, and every other endpoint. A change to a route's Zod schema triggers a TypeScript error at the exact call site that consumes it — the CLI never sends a malformed request that the engine then rejects at runtime.

Trade-off: the CLI is locked to the same TypeScript repo as the engine. That is correct for an in-repo first-party CLI, and it is exactly why external consumers use the `openapi.json`-driven path documented in `24-openapi-and-clients.md` instead.

## Output conventions

- Default output is human-readable text suitable for a terminal: tab-separated columns, ANSI colors when `stdout.isTTY`, no colors otherwise.
- `--output json` switches every command to JSON output, suitable for piping into `jq` or another shell tool.
- `--output table` forces a fixed-width table with headers, even when stdout is not a TTY.
- Error messages go to stderr; structured data goes to stdout. The exit code is 0 on success, 1 on a recoverable failure (e.g. validation error), 2 on a non-recoverable failure (e.g. network error or auth failure).

Trade-off: keeping `--output json` available on every command means scripts can rely on the CLI exactly the way they would rely on the typed client, without re-discovering output formats per command.

## What the CLI does **not** do

- No client-side caching of Workflow or Connector lists. Every command is a fresh round trip; consistency matters more than a few hundred milliseconds of latency on infrequent commands.
- No background daemons. The CLI exits cleanly after every invocation. `subkit chat` is the only long-lived process and it exits when the user disconnects.
- No engine-resident state. `subkit` profiles, default tenant, and last-used engine URL all live in `~/.subkit/config.json` on the operator's machine.
- No "smart" command synthesis. Every command corresponds to a specific REST or SSE endpoint, listed above.
