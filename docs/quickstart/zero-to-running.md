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

A fresh engine has no tenants. It prints a one-time **bootstrap token** (valid
15 minutes) to the logs:

```bash
docker logs subkit 2>&1 | grep -oE 'sk init --token [a-f0-9]{64}' | tail -1
# sk init --token 77e76b9b2e487ca1327bd79c390baa79670db792b553faa059508e2378ece7e7
```

> If the token has expired, just run the grep again — the engine **reprints a
> fresh token** the next time you try, so you can never get permanently stuck.

Complete setup with `sk init` (the bundled CLI runs inside the container; its
profile is saved on the `/data` volume, so the container stays logged in):

```bash
docker exec subkit sk init --token <TOKEN> \
  --admin-email you@example.com \
  --tenant-name "My Org" \
  --llm-provider anthropic \
  --llm-api-key sk-ant-YOUR-KEY
# sk init: bootstrap complete — tenant 6c82c719-…
#   admin_api_key prefix: wf_live_IKx_
#   profile 'default' saved to /data/home/.sk/config.json
```

Verify the whole setup:

```bash
docker exec subkit sk doctor
# ✔ profile / reachability / authn / version_match … (exit 0)
docker exec subkit sk -p "Say only the word: pong" --output text
# pong            ← confirms the LLM is wired correctly
```

> **Alternative:** pass the key at `docker run` time with
> `-e ANTHROPIC_API_KEY=sk-ant-YOUR-KEY` and you can skip `--llm-api-key` on
> `sk init` entirely.

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

> **Connectors that need an API key** (Stripe, GitHub, …): the same
> conversational flow asks for the secret and stores it encrypted in the vault —
> you never put a key in a workflow file. See [`docs/05-connectors.md`](../05-connectors.md).

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

## Use `sk` from your own machine (instead of `docker exec`)

`docker exec subkit sk …` is the zero-install path. To run `sk` directly on your
host:

```bash
# 1. Install the CLI (also served by your engine at /install)
curl -fsSL http://localhost:3000/install | bash

# 2. Mint a full admin key (the slug is the kebab-cased tenant name)
docker exec subkit engine --issue-admin-key --tenant my-org

# 3. Log in and verify
sk login --engine-url http://localhost:3000 --api-key wf_live_…
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
