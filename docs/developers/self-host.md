# Self-Host sk — Zero to Running

sk runs inside your own infrastructure, so your data stays where it already is. One
container, one stateful dependency (PostgreSQL), and nothing leaves your network except the
outbound calls to your LLM provider. Start from nothing and finish this page with a running
engine, an authenticated `sk` CLI, a working connector, a workflow you can run, and an
indexed knowledge article — all from the released Docker image.

```mermaid
flowchart LR
    Op["docker compose"] --> Engine["engine container<br/>(engine + sk + Cockpit + Chromium)"]
    Op --> PG
    Engine --> PG[("PostgreSQL<br/>your data, your volume")]
    Engine -. outbound only .-> LLM[("LLM provider")]
```

| What | Detail |
|---|---|
| **Time** | ~15 minutes |
| **You need** | Docker + one free [Anthropic API key](https://console.anthropic.com) |
| **Cost** | The weather API used here (open-meteo) is free and keyless |
| **Outcome** | A governed engine you own, end-to-end |

> **The primary interface is the conversational `sk` REPL.** You describe what you
> want in plain language; the AI proposes a connector or workflow, you review and
> approve. Declarative JSON and one-shot commands exist too — for scripting and CI —
> see [Scripting & CI](#scripting--ci-non-interactive). Every command and output
> below is real, run end-to-end against the released image.

---

## Concepts in 60 seconds

| Term | One line |
|---|---|
| **Tenant** | Your isolated workspace — every connector, workflow, and user lives in one tenant. |
| **Connector** | An authenticated link to an external API (here: open-meteo). |
| **Workflow** | A versioned sequence of steps (call an API, transform the result). |
| **Execution** | One immutable run of a workflow. |
| **Knowledge source** | A document (runbook, PDF) indexed for semantic search. |

Full glossary: [`docs/concepts/glossary.md`](../concepts/glossary.md).

---

## Step 1 — Run the engine

The application-complete image bundles the engine, Cockpit, migrations,
Chromium, **and** the `sk` CLI plus every supported client-platform artifact.
PostgreSQL remains a separate, mandatory service. The repository Compose file
starts the pinned application and database images together.

```bash
docker compose up -d
```

Wait a few seconds, then confirm it is healthy:

```bash
curl -s http://localhost:3000/health
# {"status":"ok","service":"subkit","version":"<version>"}

curl -s http://localhost:3000/ready
# {"status":"ready","service":"subkit","version":"<version>","checks":{"lifecycle":"pass","database":"pass"}}
```

The `subkit_data` volume holds application state — config, encryption key,
uploaded files, and the in-container CLI profile. PostgreSQL data lives in the
separate `subkit_pgdata` volume. Restarts preserve both.

---

## Step 2 — First-run bootstrap (tenant + admin key + LLM)

A fresh engine has no tenants. Complete setup with `sk init` — on the all-in-one
image the bundled CLI **auto-detects the one-time bootstrap token** the engine
dropped on the `/data` volume, so you don't copy anything:

```bash
docker compose exec engine sk init \
  --admin-email you@example.com \
  --tenant-name "My Org" \
  --llm-provider anthropic \
  --llm-api-key sk-ant-YOUR-KEY
# sk init: using bootstrap token from /data/config/bootstrap.token
# sk init: bootstrap complete — tenant 6c82c719-…
#   profile 'default' saved to /data/home/.sk/config.json
```

> **No API key handy?** Use `--llm-provider mock` to walk the mechanics with zero
> external accounts. Or set `ANTHROPIC_API_KEY` in the engine service
> environment and drop `--llm-api-key`.
>
> **Manual token (non-bundled deploys):** copy it from the logs and pass
> `--token` (valid 15 min; the engine reprints a fresh one on the next attempt):
> ```bash
> docker compose logs engine 2>&1 | grep -oE 'sk init --token [a-f0-9]{64}' | tail -1
> ```

> **Authentication defaults to the `api_key` adapter** — people are added by
> admin invite and authenticate with engine-issued API keys. Configure direct
> OIDC by adding named `oidc` records to
> `auth.providers` in `subkit.config.json`, then restart. No provider-specific
> setting or route is required.

For example, an sk-owned direct OIDC client is one configuration record:

```json
{
  "auth": {
    "providers": [
      { "protocol": "api_key", "id": "api-key", "label": "SubKit API key" },
      {
        "protocol": "oidc",
        "id": "workforce-oidc",
        "label": "Workforce OIDC",
        "issuer_url": "https://identity.example.com",
        "client_id": "<subkit-client-id>",
        "client_secret": "<subkit-client-secret>",
        "scopes": "openid profile email",
        "tenant_slug": "default"
      }
    ]
  }
}
```

The only browser endpoints remain `/v1/identity/login/start`,
`/v1/identity/login/callback`, and `/v1/identity/logout` regardless of adapter
id or vendor.

The chooser is deliberately not vendor-configurable: `mcp-auth` always
shows **Continue with SSO** first and **Continue with API key** second. Provider
ids remain opaque deployment configuration, discovery returns canonical
labels (`SSO`, `API key`), and assertion exchange uses only
`POST /v1/identity/sessions` with the shared
`{provider_id,identity_token}` → `{api_key,principal_id,context_id,email}`
contract. The immutable OIDC `sub` is required; `email` is nullable and
contains only a provider-verified address.

Verify:

```bash
docker compose exec engine sk doctor
# ✔ profile / reachability / authn / setup / version_match … (exit 0)
docker compose exec engine sk -p "Say only the word: pong" --output text
# pong            ← confirms the LLM is wired correctly
```

---

## Step 3 — Build by talking to it (the `sk` REPL) ★

This is the main way to use sk. Open the interactive REPL (it needs a terminal,
so add `-it`):

```bash
docker compose exec engine sk
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
into context. Full walkthrough: [`repl-tour.md`](../authors/repl-tour.md).

> **One-shot / scripted?** The exact same authoring loop runs non-interactively
> with `sk -p "<request>"` — see [Scripting & CI](#scripting--ci-non-interactive).

---

## Step 4 — Inspect what you built

Whether you authored in the REPL or via a script, the artifacts are normal,
versioned resources you can list and run:

```bash
docker compose exec engine sk connectors list                 # name + slug + status
docker compose exec engine sk connectors test <CONNECTOR_ID>  # re-probe connectivity
docker compose exec engine sk workflows run berlin-current-temperature --follow
docker compose exec engine sk executions list --limit 5
docker compose exec engine sk executions result <EXECUTION_ID>  # the value it produced
```

---

## Step 5 — Add a knowledge article

In the REPL you can just say *“add this file as a knowledge source tagged
weather, runbook”*. The scriptable form:

```bash
docker compose cp note.md engine:/tmp/note.md
docker compose exec engine sk knowledge-sources create --file /tmp/note.md \
  --title "Weather Runbook" --tags "weather,runbook,open-meteo"
# ✓ Created knowledge source "Weather Runbook" · 4 chunks
docker compose exec engine sk knowledge-sources list
docker compose exec engine sk knowledge-sources search "open-meteo"   # semantic search; ranks by relevance
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
[mcp_servers.sk]
url = "http://localhost:3000/mcp"
bearer_token_env_var = "SK_API_KEY"
```
```bash
export SK_API_KEY=wf_live_…   # the key from `engine --issue-admin-key`
```

Inline-header JSON shape (Claude Desktop / Cursor):

```json
{ "mcpServers": { "sk": {
  "url": "http://localhost:3000/mcp",
  "transport": "streamable-http",
  "headers": { "Authorization": "Bearer wf_live_…" }
} } }
```

For **Claude Code**, register from the shell instead — and see
[Use sk from a coding agent](../authors/coding-agents.md) for the full loop
(briefing hook + knowledge import), which this step does not cover:

```bash
claude mcp add --transport http --scope user sk http://localhost:3000/mcp \
  --header "Authorization: Bearer ${SK_API_KEY}"
```

Once connected over HTTP, the client sees your tenant's tools — author and run
workflows through the authoring triad (`author_workflow` to build a grounded
draft, `dry_run_workflow` to test it, `edit_workflow_patch` to refine it, and
`save_workflow_draft` to commit), inspect connectors (`test_connector`,
`list_recipes`), ground answers (`search_knowledge_v2`, `read_knowledge`), and
more. Destructive calls require a confirm first.

**B. stdio (local, conversation-only).** After `sk login`, a client can spawn
the bundled proxy, which reads `~/.sk/config.json` so no key handling is needed:

```json
{ "mcpServers": { "sk-cli": { "command": "sk", "args": ["mcp"] } } }
```

This proxy is deliberately narrow: it exposes only `sk_ping` and
`sk_conversation_create` / `_append` / `_get` / `_list`, for driving the
conversation surface from an IDE plugin. It does **not** carry the tool
catalog above — if you want knowledge lookup, workflow authoring, or connector
tools, use the HTTP path.

Verify the HTTP endpoint by hand:

```bash
curl -s http://localhost:3000/mcp \
  -H "Authorization: Bearer wf_live_…" -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
# → 200 with an mcp-session-id response header
```

---

## Use `sk` from your own machine (instead of `docker exec`)

`docker compose exec engine sk …` is the zero-install path. To run `sk` directly on your
host:

```bash
# 1. Install the CLI (also served by your engine at /install)
curl -fsSL http://localhost:3000/install | bash

# 2. Mint a full admin key — prints a ready-to-paste `sk login` line
docker compose exec engine engine --issue-admin-key --tenant my-org
#   run this on your machine to log the host `sk` in:
#     sk login --engine-url http://localhost:3000 --api-key wf_live_…

# 3. Paste that line, then open the REPL on your machine
sk status
sk            # the same conversational REPL, now host-native
```

Host config lives at `~/.sk/config.json`.

---

## Add a teammate (multi-user)

With the local `subkit` provider, an admin provisions each teammate and the
teammate mints their **own** personal API key from a single-use invite — the
admin never sees that key. Three commands, in order:

```bash
# 1. Admin: create the user (roles: admin | member | enduser, default member)
docker compose exec engine sk users create --email teammate@example.com --role member
# created user
#   id     <USER_ID>
#   email  teammate@example.com
#   role   member

# 2. Admin: issue a single-use invite — the wf_invite_ token is shown ONCE
docker compose exec engine sk users invite <USER_ID>
# invite issued for user <USER_ID>
#   token    wf_invite_…
#   expires  …
# the invited user runs:
#   sk join --invite wf_invite_…
```

```bash
# 3. Teammate (on their own machine, no login required): redeem the token to
#    provision a personal API key into their ~/.sk profile
sk join --invite wf_invite_… --engine-url http://localhost:3000
# sk join: joined — profile 'default' saved to ~/.sk/config.json
#   personal api key prefix: wf_live_…
#   next: sk status
```

Hand the token over securely — it works only once. Admins can review or revoke
un-redeemed invites with `sk invites list` and `sk invites revoke <invite-id>`.

---

## Settings — one surface

Every runtime setting is managed with `sk settings` (the REPL's `/config` opens
the same thing):

```bash
docker compose exec engine sk settings list                       # every leaf + value
docker compose exec engine sk settings get llm.provider
docker compose exec engine sk settings set llm.model '"claude-sonnet-4-6"'   # value is JSON
docker compose exec engine sk settings configure                  # interactive UI
```

A few values are **not** `sk settings` on purpose: `MASTER_KEY`, `DATABASE_URL`,
and `ENGINE_LISTEN_HOST` are bootstrap env vars (needed before the engine/API
exist), and `engine --issue-admin-key` mints the *first* key (after that,
`sk apikeys create`). See [Operator configuration reference](#operator-configuration-reference) below.

---

## Scripting & CI (non-interactive)

The REPL is for humans; these are for automation. Same engine, same governance.

**Headless authoring** — the conversational loop without a TTY (no slash
commands; the AI completes autonomously up to `--max-turns`):

```bash
docker compose exec engine sk -p "Create a keyless HTTP connector named open-meteo for \
https://api.open-meteo.com, endpoint GET /v1/forecast, then probe it." --output text
docker compose exec engine sk -p "list my workflows" --output json
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
docker compose exec engine sk workflows create --file /tmp/weather.json   # validate→preview→save
docker compose exec engine sk workflows run berlin-current-temperature --follow
```

**Key-based connector, fully scripted** — create from a template, attach the
credential without a conversation:

```bash
docker compose exec engine sk connectors create --template stripe --name stripe-prod --skip-checks
docker compose exec engine sk credentials set <CONNECTOR_ID> --mode bearer --token sk_live_…
#   modes: bearer | header | query | basic | aws_sigv4 | none  (probes after, unless --skip-checks)
docker compose exec engine sk credentials list <CONNECTOR_ID>
```

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `llm_provider_misconfigured` on an AI command | Provider key missing/wrong: `sk settings set llm.providers.anthropic.api_key '"sk-ant-…"'` (or re-run `sk init`), then `sk -p "ping"`. |
| `bootstrap token expired` | Re-run `sk init` (it auto-detects a fresh token) or re-grep the logs (Step 2). |
| Connector `probe failed` | Wrong base URL / endpoint — tell the REPL the correct values and `/probe`. |
| `validation failed` on `workflows create` | Check the JSON against the Scripting section; `connector_id` must be a real id from `sk connectors list`. |
| Interactive prompt hangs under `docker compose exec` | Run it from an interactive terminal; Compose allocates a TTY by default. |

---

## Production deployment

The quickstart above uses the same application image as production with a
separate PostgreSQL container. For production, replace that database service
with managed PostgreSQL and put the engine behind your TLS ingress.

### Deployment Topology

sk compiles to a single binary whose only stateful dependency is PostgreSQL. The
job queue, cron scheduler, and pub/sub event bus all run **inside** the engine
process, backed by PostgreSQL. No message broker, no distributed queue, no
coordination service — one dependency, and an entire class of distributed-systems
failure modes designed away.

```mermaid
flowchart TB
    Internet(("Internet"))
    Proxy["TLS reverse proxy / LB<br/>(your choice)"]
    Engine["engine container<br/>mikebild/subkit"]
    PG[("PostgreSQL")]
    LLM[("LLM Provider<br/>Anthropic / OpenAI / Google")]
    S3[("S3 (optional)<br/>step-result spillover")]

    Internet -- :443 --> Proxy
    Proxy -- :3000 --> Engine
    Engine --> PG
    Engine -. outbound .-> LLM
    Engine -. outbound .-> S3
```

| Concern | How sk handles it |
|---|---|
| **Queue / scheduler / events** | pg-boss + outbox in PostgreSQL — nothing extra to run |
| **Standard model** | one engine service + one PostgreSQL instance |
| **High availability** | run multiple engine containers behind a load balancer (no coordination overhead) |
| **Production database** | point at [external PostgreSQL](#external-database); engine auto-migrates on boot |
| **Release-image rehearsal** | `docker-compose.yml` runs the released engine image and a separate PostgreSQL service |

### Installation

| Channel | Detail |
|---|---|
| **Binaries** | macOS (Intel + Apple Silicon), Linux (x64 + ARM64), Windows (x64) |
| **Primary binaries** | `sk` (CLI) and the engine — docs and examples use `sk` |
| **Install script** | one-liner for bash and PowerShell |
| **Container** | published image for Kubernetes / cloud-native deployments |
| **Auto-update** | binaries check on startup and update in place, gated by a signed `SHA256SUMS` — see [`../admins/credentials-and-keys.md`](../admins/credentials-and-keys.md) |

---

## Operator configuration reference

Every **runtime setting** is managed with `sk settings` (get / set / list / `configure`) — that is the one surface you need. The env vars below are deliberately *not* `sk settings`, and for a reason worth knowing:

- **`MASTER_KEY` / `DATABASE_URL` / `ENGINE_LISTEN_HOST` are bootstrap-only.** They're needed *before* the engine, its database, or its HTTP API exist — `MASTER_KEY` decrypts the credential vault, `DATABASE_URL` is *how* the engine reaches the database where settings are stored, and `ENGINE_LISTEN_HOST` is where the server binds. `sk settings` talks to a *running* engine, so it cannot set them (chicken-and-egg). `MASTER_KEY` isn't even a config leaf.
- **`engine --issue-admin-key` is the operator escape hatch for the *first* key.** `sk` authenticates with an API key, so it can't mint its own first one; that runs directly against the database on the `engine` binary. Once you have a key, `sk apikeys create` mints more through the API.
- **`SK_OVERRIDE_*` is the no-disk complement to `sk settings`** — ephemeral env overrides for CI / secret managers, re-applied each boot, never persisted.

Everything else lives in `subkit.config.json` on the volume. Full leaf reference: [`../admins/settings-reference.md`](../admins/settings-reference.md); the surrounding configuration model is [`../admins/configuration.md`](../admins/configuration.md).

| Env var | Default | Purpose |
|---|---|---|
| `MASTER_KEY` | auto-generated + persisted to `/data/config/master.key` | 64-hex AES-256 key for at-rest credential encryption. **Set your own in production** — losing it makes stored credentials unrecoverable. |
| `DATABASE_URL` | **required** | PostgreSQL connection URL. The image does not contain a database server. `DATABASE_URL_FILE` is also supported. |
| `ENGINE_LISTEN_HOST` | `0.0.0.0` | Bind interface. The image defaults to all-interfaces so `-p` works; leave it. |
| `SK_OVERRIDE_*` | — | Override any config leaf at runtime (e.g. `SK_OVERRIDE_LLM_API_KEY`). |
| `NODE_ENV` | `production` | — |

### Bring your own MASTER_KEY

```bash
MASTER_KEY="$(openssl rand -hex 32)" docker compose up -d
```

Store it somewhere safe and pass the **same** value on every run — it must stay constant or previously encrypted credentials become unreadable. Rotation procedure: [`../admins/credentials-and-keys.md`](../admins/credentials-and-keys.md).

### External database

Connect the image to PostgreSQL (managed RDS, a separate container, etc.). The
database is mandatory and the engine auto-migrates on boot:

```bash
docker run -d --name subkit -p 3000:3000 -v subkit-data:/data \
  -e DATABASE_URL="postgres://user:pass@db-host:5432/subkit" \
  -e MASTER_KEY="<your-64-hex-key>" \
  mikebild/subkit:6.22.35
```

### Persistence & upgrades

Application state lives in `/data`; durable relational state lives in
PostgreSQL. Back up both. To upgrade the Compose deployment, change the pinned
`SUBKIT_IMAGE_TAG`, pull, and recreate the engine. Migrations apply
automatically on boot:

```bash
SUBKIT_IMAGE_TAG=<new-version> docker compose pull engine
SUBKIT_IMAGE_TAG=<new-version> docker compose up -d engine
curl -fsS http://127.0.0.1:3000/health
curl -fsS http://127.0.0.1:3000/ready
```

### Notes & limits

- **Web-scraping connector**: the image includes the Playwright-matched Chromium build and its operating-system libraries.
- **File scanning**: uploads are not virus-scanned by default — see [`../admins/production-hardening.md`](../admins/production-hardening.md) before accepting untrusted uploads.
- **Horizontal scaling**: run multiple engine containers against the same external PostgreSQL database and blob-storage strategy, behind a load balancer.

---

## Cleanup & next steps

```bash
docker compose down            # stop and remove containers; preserve volumes
docker compose down --volumes  # also erase application and database data
```

- [**Using the `sk` REPL**](../authors/repl-tour.md) — the primary interface, in depth.
- [`docs/concepts/connectors.md`](../concepts/connectors.md) — connectors, credentials, OAuth2.
- [`docs/concepts/workflows.md`](../concepts/workflows.md) — steps, versioning, scheduling.
- [`docs/authors/authoring-workflows.md`](../authors/authoring-workflows.md) — conversational authoring, skills, knowledge.
- Operator setup (TLS, external DB, settings): [Production deployment](#production-deployment) below.
