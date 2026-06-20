# Quickstart — Zero to Running

**No prior knowledge required.** Start from nothing and finish with a running
engine, an authenticated `sk` CLI, a working connector, a workflow you can run,
and a knowledge article — all from the released Docker image.

This entire guide was run end-to-end against `mikebild/subkit:latest`
(engine `7.0.1`); every command and output below is real.

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

Full glossary: [`docs/02-concepts.md`](../02-concepts.md).

---

## Step 1 — Run the engine

The all-in-one image bundles the engine, PostgreSQL, **and** the `sk` CLI.

```bash
docker run -d --name subkit -p 3000:3000 -v subkit-data:/data mikebild/subkit:latest
```

Wait a few seconds, then confirm it is healthy:

```bash
curl -s http://localhost:3000/v1/health
# {"status":"ok","version":"7.0.1","db_connected":true,"uptime_seconds":3}
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
#   admin_api_key prefix: wf_live_IKx_
#   profile 'default' saved to /data/home/.sk/config.json
```

> **No API key handy?** Use `--llm-provider mock` to walk the connector/workflow
> mechanics with zero external accounts (authoring quality is limited, but the
> full pipeline runs). Or pass `-e ANTHROPIC_API_KEY=sk-ant-…` at `docker run`
> time and drop `--llm-api-key` here.
>
> **Manual token (non-bundled deploys):** copy it from the logs and pass
> `--token` explicitly. It's valid 15 minutes; the engine reprints a fresh one
> on the next attempt, so you can't get stuck:
> ```bash
> docker logs subkit 2>&1 | grep -oE 'sk init --token [a-f0-9]{64}' | tail -1
> ```

Verify the whole setup:

```bash
docker exec subkit sk doctor
# ✔ profile / reachability / authn / setup / version_match … (exit 0)
docker exec subkit sk -p "Say only the word: pong" --output text
# pong            ← confirms the LLM is wired correctly
```

---

## Step 3 — Create a connector (conversational)

There is no weather template, so you describe the connector in natural language
and the AI builds, saves, and probes it. open-meteo is keyless:

```bash
docker exec -i subkit sk -p "Create an HTTP connector named 'open-meteo' for the \
Open-Meteo forecast API. Base URL https://api.open-meteo.com. No authentication \
(free, keyless). Main endpoint GET /v1/forecast with query params latitude, \
longitude, current. Create it, then probe it." --output text
```

Result (real run):

```
open-meteo is live — HTTP connector (dev), saved as 1be01b5a-….
- Probe: GET /v1/forecast?latitude=52.52&longitude=13.41&current=temperature_2m → HTTP 200 in 39ms
- Sample: Berlin, 30.6 °C
```

Confirm and grab the id:

```bash
docker exec subkit sk connectors list
docker exec subkit sk connectors test <CONNECTOR_ID>
```

> **Connectors that need an API key** (Stripe, GitHub, …): the conversational
> flow asks for the secret and stores it encrypted in the vault. For
> **scripted / CI** setup, create from a template and attach the credential
> without a conversation:
> ```bash
> docker exec subkit sk connectors create --template stripe --name stripe-prod --skip-checks
> docker exec subkit sk credentials set <CONNECTOR_ID> --mode bearer --token sk_live_…
> #   modes: bearer | header | query | basic | aws_sigv4 | none  (probes after, unless --skip-checks)
> ```
> You never put a key in a workflow file. See [`docs/05-connectors.md`](../05-connectors.md).

---

## Step 4 — Create and run a workflow

You can author conversationally (`sk "create a workflow that returns the current
temperature in Berlin using the open-meteo connector"`), or declaratively from a
JSON file — shown here because it is exact and repeatable. Save `weather.json`
(replace `connector_id` with yours from Step 3):

```json
{
  "name": "Berlin Current Temperature",
  "slug": "berlin-current-temperature",
  "description": "Current temperature in Berlin via the open-meteo connector",
  "steps": [
    {
      "id": "fetch_weather",
      "kind": "request",
      "method": "GET",
      "path": "/v1/forecast",
      "query": { "latitude": "52.52", "longitude": "13.41", "current": "temperature_2m" },
      "on_error": "fail",
      "connector_id": "1be01b5a-bcfd-4b26-b151-81df3743194a"
    },
    {
      "id": "extract_temperature",
      "kind": "transform",
      "language": "javascript",
      "on_error": "fail",
      "expression": "const c = input.scope.fetch_weather.data.current; return { city: 'Berlin', time: c.time, temperature_c: c.temperature_2m };"
    }
  ]
}
```

Copy it into the container and create the workflow. `create` runs
**validate → preview (a real dry-run) → save**, so a green result proves the
connector actually works:

```bash
docker cp weather.json subkit:/tmp/weather.json
docker exec subkit sk workflows create --file /tmp/weather.json
# ✓ Created workflow "Berlin Current Temperature" · id=2d35d483-… · version=1
```

Run it and watch the steps stream live:

```bash
docker exec subkit sk workflows run berlin-current-temperature --follow
# execution.step.finished … fetch_weather … succeeded (40ms)
# execution.step.finished … extract_temperature … succeeded (5ms)
# execution.succeeded
docker exec subkit sk executions list --limit 5
```

---

## Step 5 — Add a knowledge article

Create a small markdown file `note.md`, then upload it. Explicit `--tags` are
merged with AI-generated tags and a description:

```bash
docker cp note.md subkit:/tmp/note.md
docker exec subkit sk knowledge-sources create --file /tmp/note.md \
  --title "Weather Runbook" --tags "weather,runbook,open-meteo"
# ✓ Created knowledge source "Weather Runbook" · id=2fcd7728-… · 4 chunks
docker exec subkit sk knowledge-sources list
docker exec subkit sk knowledge-sources search "how do I get the temperature for Berlin"
# Weather Runbook §3 … (semantic search hit)
```

---

## Step 6 — Author by conversation (the `sk` REPL)

Everything above used one-shot commands. The friendliest way to build is to just
**talk to the engine** — the AI proposes, you approve. Open the interactive REPL
(needs a TTY, so add `-it`):

```bash
docker exec -it subkit sk
```

A real session looks like this:

```text
You    ▸ get the current temperature in Munich using the open-meteo connector
AI     ▸ Here's the workflow I propose:
         1. request   GET /v1/forecast?latitude=48.14&longitude=11.58&current=temperature_2m
         2. transform extract { city, time, temperature_c }
         (dry-run preview: 22.1 °C)
         Approve to save this as a workflow?
You    ▸ /approve
AI     ▸ Saved "munich-current-temperature" (v1). Run it: sk workflows run munich-current-temperature
```

Useful inside the REPL — type `/` for the menu:

| Command | Does |
|---|---|
| `/approve` · `/reject` | commit or revise the AI's current proposal |
| `/connector-templates` | browse the 105 built-in integrations |
| `/knowledge` · `/skills` | manage knowledge sources / reusable context |
| `/clear` · `/help` · `/exit` | new conversation · list commands · leave |

`@file:<id>` attaches a file; `@skill:<name>` pulls in a Skill. Nothing is saved
or run until you approve. Full walkthrough: [`using-the-repl.md`](./using-the-repl.md).

> **Scripting?** The same loop runs headless: `sk -p "create a workflow that …"
> --output text` (no TTY, no slash commands; the AI completes autonomously up to
> `--max-turns`). `--output json` / `stream-json` for machine consumption.

---

## Step 7 — Use it from Codex / any MCP client

The engine is an **MCP server**, so AI coding tools (Codex, Claude Desktop,
Cursor, …) can drive your governed workflows directly. Two transports:

**A. Streamable HTTP (recommended)** — point the client at `${ENGINE_URL}/mcp`
with a Bearer key (mint one with `engine --issue-admin-key`, see "from your own
machine" below). For **Codex** (`~/.codex/config.toml`, or Settings → MCP
Servers) — Codex auto-detects the transport from `url`, and
`bearer_token_env_var` names an env var so the key stays out of the file:

```toml
[mcp_servers.subkit]
url = "http://localhost:3000/mcp"
bearer_token_env_var = "SUBKIT_API_KEY"
```

```bash
export SUBKIT_API_KEY=wf_live_…   # the key from `engine --issue-admin-key`
```

Equivalent JSON for clients that take an inline header map (Claude Desktop /
Cursor) — this is the shape subkit's own connector recipe emits:

```json
{ "mcpServers": { "subkit": {
  "url": "http://localhost:3000/mcp",
  "transport": "streamable-http",
  "headers": { "Authorization": "Bearer wf_live_…" }
} } }
```

**B. stdio (local)** — after `sk login` on your machine, let the client spawn the
bundled proxy (reads `~/.sk/config.json`):

```json
{ "mcpServers": { "subkit": { "command": "sk", "args": ["mcp"] } } }
```

Once connected, the client sees your tenant's tools — author and run workflows
(`author_workflow`, `build_workflow`, `dry_run_workflow`, `start_workflow_from_recipe`),
inspect connectors (`test_connector`, `list_recipes`), and more. Destructive
calls return a confirm prompt before they execute. Verify the endpoint by hand:

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

# 3. Paste that line, then verify
sk status
```

Now any command above works without the `docker exec subkit` prefix
(e.g. `sk connectors list`). Host config lives at `~/.sk/config.json`.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `llm_provider_misconfigured` / provider error on an AI command | The provider key is missing or wrong. Set it with `sk settings set llm.providers.anthropic.api_key '"sk-ant-…"'` (or re-run `sk init`), then `sk -p "ping"`. |
| `bootstrap token expired` | Re-grep the logs for a fresh token (Step 2) and re-run `sk init`. |
| Connector `probe failed` | Wrong base URL / endpoint — re-run the Step 3 prompt with the correct values. |
| `validation failed` on `workflows create` | Check the JSON shape against Step 4; `connector_id` must be a real id from `sk connectors list`. |
| Interactive prompt hangs under `docker exec` | Add `-it`: `docker exec -it subkit sk …`. |

---

## Cleanup & next steps

```bash
docker rm -f subkit            # stop & remove the container
docker volume rm subkit-data   # also wipe all state (optional)
```

- [**Using the `sk` REPL**](./using-the-repl.md) — author connectors and workflows by conversation (the recommended day-to-day flow).
- [`docs/05-connectors.md`](../05-connectors.md) — connectors, credentials, OAuth2.
- [`docs/06-execution.md`](../06-execution.md) — steps, versioning, scheduling.
- [`docs/04-authoring.md`](../04-authoring.md) — conversational authoring, skills, knowledge.
- Operator-focused setup (TLS, external DB): [`docs/operations/docker.md`](../operations/docker.md).
