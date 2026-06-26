# Quickstart — Zero to Running

**No prior knowledge required.** Start from nothing and finish with a running
engine, an authenticated `sk` CLI, a working connector, a workflow you can run,
and a knowledge article — all from the released Docker image.

> **The primary interface is the conversational `sk` REPL.** You describe what
> you want in plain language; the AI proposes a connector or workflow, you
> review and approve. That's the easiest path for a human and the one to learn
> first. Declarative JSON files and one-shot commands exist too — they're for
> scripting and CI — and live in [Scripting & CI](#scripting--ci-non-interactive)
> at the end.

This guide was run end-to-end against the released image; every command and
output below is real.

> **Time:** ~15 minutes.
> **You need:** Docker, and one free **Anthropic API key**
> (https://console.anthropic.com → API keys). The weather API used here
> (open-meteo) is **free and needs no key**.

---

## Concepts in 60 seconds

| Term | One line |
|---|---|
| **Tenant** | Your isolated workspace — every connector, workflow, and user lives in one tenant. |
| **Connector** | An authenticated link to an external API (here: open-meteo). |
| **Workflow** | A versioned sequence of steps (call an API, transform the result). |
| **Execution** | One immutable run of a workflow. |
| **Knowledge source** | A document (runbook, PDF) indexed for semantic search. |

Full glossary: [`docs/concepts.md`](../concepts.md).

---

## Step 1 — Run the engine

The all-in-one image bundles the engine, PostgreSQL, **and** the `sk` CLI.

```bash
docker run -d --name subkit -p 3000:3000 -v subkit-data:/data mikebild/subkit:latest
```

Wait a few seconds, then confirm it is healthy:

```bash
curl -s http://localhost:3000/v1/health
# {"status":"ok","version":"7.2.2","db_connected":true,"uptime_seconds":3}
```

The `subkit-data` volume holds **all** state (database, config, encryption key,
uploaded files) so restarts keep your data.

---

## Step 2 — First-run bootstrap (tenant + admin key + LLM)

A fresh engine has no tenants. Complete setup with `sk init` — on the all-in-one
image the bundled CLI **auto-detects the one-time bootstrap token** the engine
dropped on the `/data` volume, so you don't copy anything:

```bash
docker exec subkit sk init \
  --admin-email you@example.com \
  --tenant-name "My Org" \
  --llm-provider anthropic \
  --llm-api-key sk-ant-YOUR-KEY
# sk init: using bootstrap token from /data/config/bootstrap.token
# sk init: bootstrap complete — tenant 6c82c719-…
#   profile 'default' saved to /data/home/.sk/config.json
```

> **No API key handy?** Use `--llm-provider mock` to walk the mechanics with zero
> external accounts. Or pass `-e ANTHROPIC_API_KEY=sk-ant-…` at `docker run` time
> and drop `--llm-api-key`.
>
> **Manual token (non-bundled deploys):** copy it from the logs and pass
> `--token` (valid 15 min; the engine reprints a fresh one on the next attempt):
> ```bash
> docker logs subkit 2>&1 | grep -oE 'sk init --token [a-f0-9]{64}' | tail -1
> ```

Verify:

```bash
docker exec subkit sk doctor
# ✔ profile / reachability / authn / setup / version_match … (exit 0)
docker exec subkit sk -p "Say only the word: pong" --output text
# pong            ← confirms the LLM is wired correctly
```

---

## Step 3 — Build by talking to it (the `sk` REPL) ★

This is the main way to use sk. Open the interactive REPL (it needs a terminal,
so add `-it`):

```bash
docker exec -it subkit sk
```

Now just say what you want. The AI proposes; **nothing is saved or run until you
`/approve`.** A real session — connector, then workflow, then a run — looks like:

```text
you ▸ create a keyless HTTP connector for the open-meteo forecast API
      (https://api.open-meteo.com, endpoint GET /v1/forecast), then probe it
 sk ▸ Created connector "open-meteo" (http, dev). Probe: GET /v1/forecast… → HTTP 200. ✓

you ▸ now a workflow that returns the current temperature in Berlin using it
 sk ▸ Proposed workflow "berlin-current-temperature":
        1. request   GET /v1/forecast?latitude=52.52&longitude=13.41&current=temperature_2m
        2. transform extract { city, time, temperature_c }
      Dry-run preview → { city: "Berlin", temperature_c: 23.7 }. Approve to save?
you ▸ /approve
 sk ▸ Saved "berlin-current-temperature" (v1).
you ▸ run it
 sk ▸ execution succeeded → { city: "Berlin", time: "…", temperature_c: 23.7 }
```

That's the whole loop: **describe → review the proposal + dry-run → `/approve` →
run.** You never hand-write JSON or look up an API shape.

### Slash commands (type `/` for the menu)

The ones you'll reach for, grouped by what they do (verified against the shipped
build):

| Command | Does |
|---|---|
| `/approve` · `/reject` | commit the AI's current proposal, or reject it (with a reason) |
| `/preview` · `/probe` | dry-run the workflow draft / test the connector draft now |
| `/draft` · `/connector` · `/workflow` | inspect the current authoring state |
| `/templates` | browse connector templates suggested for the draft |
| `/onboard` | guided wizard: pick a template, enter credentials, probe, save |
| `/versions` · `/restore <n>` | list committed workflow versions / roll back |
| `/skills` · `/knowledge` | list reusable context / knowledge sources in scope |
| `/clear` (`/new`) · `/compact` · `/resume` | new conversation · shrink history · reattach |
| `/setup` · `/status` · `/cost` · `/usage` | readiness · session+persona · token budget |
| `/config` · `/settings` | open the searchable settings UI (every engine setting) |
| `/model` · `/tenant` · `/login` · `/logout` | switch model · switch/list tenants · auth |
| `/attach` · `/upload` · `/files` | attach a file to the message · upload · list files |
| `/help` · `/exit` (`/quit`) | cheat sheet · leave |

Mentions: `@file:<id>` attaches an uploaded file; `@skill:<name>` pulls a Skill
into context. Full walkthrough: [`using-the-repl.md`](./using-the-repl.md).

> **One-shot / scripted?** The exact same authoring loop runs non-interactively
> with `sk -p "<request>"` — see [Scripting & CI](#scripting--ci-non-interactive).

---

## Step 4 — Inspect what you built

Whether you authored in the REPL or via a script, the artifacts are normal,
versioned resources you can list and run:

```bash
docker exec subkit sk connectors list                 # name + slug + status
docker exec subkit sk connectors test <CONNECTOR_ID>  # re-probe connectivity
docker exec subkit sk workflows run berlin-current-temperature --follow
docker exec subkit sk executions list --limit 5
docker exec subkit sk executions result <EXECUTION_ID>  # the value it produced
```

---

## Step 5 — Add a knowledge article

In the REPL you can just say *“add this file as a knowledge source tagged
weather, runbook”*. The scriptable form:

```bash
docker cp note.md subkit:/tmp/note.md
docker exec subkit sk knowledge-sources create --file /tmp/note.md \
  --title "Weather Runbook" --tags "weather,runbook,open-meteo"
# ✓ Created knowledge source "Weather Runbook" · 4 chunks
docker exec subkit sk knowledge-sources list
docker exec subkit sk knowledge-sources search "open-meteo"   # semantic search; ranks by relevance
```

`--tags` you supply are authoritative (no AI auto-tagging); omit both `--tags`
and `--description` to let the engine generate them.

---

## Step 6 — Use it from Codex / any MCP client

The engine is an **MCP server**, so AI coding tools (Codex, Claude Desktop,
Cursor, …) can drive your governed workflows directly. Mint a Bearer key first
(see [from your own machine](#use-sk-from-your-own-machine-instead-of-docker-exec)).

**A. Streamable HTTP (recommended).** For **Codex** (`~/.codex/config.toml`, or
Settings → MCP Servers) — Codex auto-detects the transport from `url`, and
`bearer_token_env_var` names an env var so the key stays out of the file:

```toml
[mcp_servers.subkit]
url = "http://localhost:3000/mcp"
bearer_token_env_var = "SUBKIT_API_KEY"
```
```bash
export SUBKIT_API_KEY=wf_live_…   # the key from `engine --issue-admin-key`
```

Inline-header JSON shape (Claude Desktop / Cursor):

```json
{ "mcpServers": { "subkit": {
  "url": "http://localhost:3000/mcp",
  "transport": "streamable-http",
  "headers": { "Authorization": "Bearer wf_live_…" }
} } }
```

**B. stdio (local).** After `sk login` on your machine, let the client spawn the
bundled proxy (reads `~/.sk/config.json`):

```json
{ "mcpServers": { "subkit": { "command": "sk", "args": ["mcp"] } } }
```

Once connected, the client sees your tenant's tools — author and run workflows
(`author_workflow`, `build_workflow`, `dry_run_workflow`), inspect connectors
(`test_connector`, `list_recipes`), and more. Destructive calls require a confirm
first. Verify the endpoint by hand:

```bash
curl -s http://localhost:3000/mcp \
  -H "Authorization: Bearer wf_live_…" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# → 200 with an mcp-session-id response header
```

---

## Use `sk` from your own machine (instead of `docker exec`)

`docker exec subkit sk …` is the zero-install path. To run `sk` directly on your
host:

```bash
# 1. Install the CLI (also served by your engine at /install)
curl -fsSL http://localhost:3000/install | bash

# 2. Mint a full admin key — prints a ready-to-paste `sk login` line
docker exec subkit engine --issue-admin-key --tenant my-org
#   run this on your machine to log the host `sk` in:
#     sk login --engine-url http://localhost:3000 --api-key wf_live_…

# 3. Paste that line, then open the REPL on your machine
sk status
sk            # the same conversational REPL, now host-native
```

Host config lives at `~/.sk/config.json`.

---

## Settings — one surface

Every runtime setting is managed with `sk settings` (the REPL's `/config` opens
the same thing):

```bash
docker exec subkit sk settings list                       # every leaf + value
docker exec subkit sk settings get llm.provider
docker exec subkit sk settings set llm.model '"claude-sonnet-4-6"'   # value is JSON
docker exec subkit sk settings configure                  # interactive UI
```

A few values are **not** `sk settings` on purpose: `MASTER_KEY`, `DATABASE_URL`,
and `ENGINE_LISTEN_HOST` are bootstrap env vars (needed before the engine/API
exist), and `engine --issue-admin-key` mints the *first* key (after that,
`sk apikeys create`). See [`docs/operations/docker.md`](../operations/docker.md).

---

## Scripting & CI (non-interactive)

The REPL is for humans; these are for automation. Same engine, same governance.

**Headless authoring** — the conversational loop without a TTY (no slash
commands; the AI completes autonomously up to `--max-turns`):

```bash
docker exec subkit sk -p "Create a keyless HTTP connector named open-meteo for \
https://api.open-meteo.com, endpoint GET /v1/forecast, then probe it." --output text
docker exec subkit sk -p "list my workflows" --output json
```

**Declarative workflow** — exact and repeatable; `create` runs
**validate → preview (real dry-run) → save**, so a green result proves the
connector works. Save `weather.json` (use your connector id from
`sk connectors list`):

```json
{
  "name": "Berlin Current Temperature",
  "slug": "berlin-current-temperature",
  "steps": [
    { "id": "fetch_weather", "kind": "request", "method": "GET", "path": "/v1/forecast",
      "query": { "latitude": "52.52", "longitude": "13.41", "current": "temperature_2m" },
      "on_error": "fail", "connector_id": "<CONNECTOR_ID>" },
    { "id": "extract_temperature", "kind": "transform", "language": "javascript", "on_error": "fail",
      "expression": "const c = input.scope.fetch_weather.data.current; return { city: 'Berlin', time: c.time, temperature_c: c.temperature_2m };" }
  ]
}
```
```bash
docker cp weather.json subkit:/tmp/weather.json
docker exec subkit sk workflows create --file /tmp/weather.json   # validate→preview→save
docker exec subkit sk workflows run berlin-current-temperature --follow
```

**Key-based connector, fully scripted** — create from a template, attach the
credential without a conversation:

```bash
docker exec subkit sk connectors create --template stripe --name stripe-prod --skip-checks
docker exec subkit sk credentials set <CONNECTOR_ID> --mode bearer --token sk_live_…
#   modes: bearer | header | query | basic | aws_sigv4 | none  (probes after, unless --skip-checks)
docker exec subkit sk credentials list <CONNECTOR_ID>
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `llm_provider_misconfigured` on an AI command | Provider key missing/wrong: `sk settings set llm.providers.anthropic.api_key '"sk-ant-…"'` (or re-run `sk init`), then `sk -p "ping"`. |
| `bootstrap token expired` | Re-run `sk init` (it auto-detects a fresh token) or re-grep the logs (Step 2). |
| Connector `probe failed` | Wrong base URL / endpoint — tell the REPL the correct values and `/probe`. |
| `validation failed` on `workflows create` | Check the JSON against the Scripting section; `connector_id` must be a real id from `sk connectors list`. |
| Interactive prompt hangs under `docker exec` | Add `-it`: `docker exec -it subkit sk …`. |

---

## Cleanup & next steps

```bash
docker rm -f subkit            # stop & remove the container
docker volume rm subkit-data   # also wipe all state (optional)
```

- [**Using the `sk` REPL**](./using-the-repl.md) — the primary interface, in depth.
- [`docs/connectors.md`](../connectors.md) — connectors, credentials, OAuth2.
- [`docs/execution.md`](../execution.md) — steps, versioning, scheduling.
- [`docs/authoring.md`](../authoring.md) — conversational authoring, skills, knowledge.
- Operator setup (TLS, external DB, settings): [`docs/operations/docker.md`](../operations/docker.md).
