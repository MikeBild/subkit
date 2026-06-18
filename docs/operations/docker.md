# Run subkit with Docker (all-in-one)

The `mikebild/subkit` image bundles the **engine and PostgreSQL in a single
container** so you can go from nothing to a working engine with one command and
zero external dependencies. It is the fastest way to try or self-host subkit.

> **Topology note.** Bundling the database into the app container is a
> deliberate *easy-onramp* trade-off — great for trials, demos, and small
> single-node self-hosting. For production at scale, run PostgreSQL separately
> (point the same image at it via `DATABASE_URL`, see [External database](#external-database))
> or use the systemd-native path in [`deploy.md`](./deploy.md).

## Quick start

```bash
docker run -d --name subkit \
  -p 3000:3000 \
  -v subkit-data:/data \
  mikebild/subkit:latest
```

That's it. On first boot the container:

1. initializes an embedded PostgreSQL cluster,
2. generates and **persists** a `MASTER_KEY` (the at-rest credential encryption key),
3. runs database migrations and starts the in-Postgres job queue,
4. serves the API on port `3000`.

Check it's healthy:

```bash
curl -s localhost:3000/v1/health      # → { version, status, … }
docker logs subkit                    # watch boot + the printed bootstrap hints
```

The named volume `subkit-data` holds **all** state (database, config, the
persisted `MASTER_KEY`, and uploaded file blobs) under `/data`, so restarts and
upgrades keep your data.

## First-run onboarding (create the first tenant + admin key)

A fresh engine has no tenants. On first boot it prints a one-time bootstrap
token to the logs:

```bash
docker logs subkit 2>&1 | grep 'sk init --token'
#   sk init --token 81789185…   ← copy the token (valid 15 minutes)
```

Complete setup with `sk init` — this creates the first tenant, mints the admin
key, **and** wires your LLM provider in one shot. The bundled CLI runs inside
the container; its profile is persisted on the `/data` volume, so the container
stays "logged in" for later `docker exec … sk …` commands:

```bash
docker exec subkit sk init --token <token> \
  --admin-email you@example.com \
  --tenant-name "My Org" \
  --llm-provider anthropic \
  --llm-api-key sk-ant-…
```

Drop the `--llm-*` flags (or use `--llm-provider mock`) to skip LLM wiring for
now. Omit all four `--admin-email/--tenant-name/--llm-*` flags and add `-it`
(`docker exec -it subkit sk init --token <token>`) for an interactive wizard.

Verify you're set up:

```bash
docker exec subkit sk doctor
```

### Get a copyable API key (for host CLI or direct API calls)

`sk init` saves the admin key into the in-container profile but only prints its
prefix. To get a full key you can paste elsewhere — e.g. to log in a `sk` CLI on
your host, or to call the API with `Authorization: Bearer …` — mint one (the
tenant slug is the kebab-cased tenant name, e.g. `My Org` → `my-org`):

```bash
docker exec subkit engine --issue-admin-key --tenant my-org   # printed once
sk login --engine-url http://localhost:3000 --api-key wf_live_…   # on your host
```

> Tip: name the tenant `default` (`--tenant-name default`) and you can later run
> `engine --issue-admin-key` with no `--tenant` flag.

## Change the LLM provider later

`sk init` wires the LLM provider for you. To change it afterwards, either edit
the persisted config (the in-container CLI is already authenticated):

```bash
docker exec subkit sk settings set llm.provider '"anthropic"'
docker exec subkit sk settings set llm.api_key  '"sk-ant-…"'
docker exec subkit sk settings set llm.model    '"claude-sonnet-4-6"'
```

…or override it ephemerally via env at `docker run` time (handy for CI / secrets
managers; not written to disk, re-applied every boot):

```bash
docker run -d --name subkit -p 3000:3000 -v subkit-data:/data \
  -e SK_OVERRIDE_LLM_PROVIDER=anthropic \
  -e SK_OVERRIDE_LLM_API_KEY=sk-ant-… \
  -e SK_OVERRIDE_LLM_MODEL=claude-sonnet-4-6 \
  mikebild/subkit:latest
```

## Configuration

The image reads only a handful of bootstrap env vars; everything else lives in
`subkit.config.json` on the volume (`docker exec subkit sk settings …` or the
`SK_OVERRIDE_*` escape hatch). Full leaf reference:
[`settings-reference.md`](./settings-reference.md).

| Env var | Default | Purpose |
|---|---|---|
| `MASTER_KEY` | auto-generated + persisted to `/data/config/master.key` | 64-hex AES-256 key for at-rest credential encryption. **Set your own in production** — losing it makes stored credentials unrecoverable. |
| `DATABASE_URL` | embedded PostgreSQL | Set to use an external database (disables the embedded one). |
| `ENGINE_LISTEN_HOST` | `0.0.0.0` | Bind interface. The image defaults to all-interfaces so `-p` works; leave it. |
| `SK_OVERRIDE_*` | — | Override any config leaf at runtime (e.g. `SK_OVERRIDE_LLM_API_KEY`). |
| `NODE_ENV` | `production` | — |

### Bring your own MASTER_KEY

```bash
docker run -d --name subkit -p 3000:3000 -v subkit-data:/data \
  -e MASTER_KEY="$(openssl rand -hex 32)" \
  mikebild/subkit:latest
```

Store it somewhere safe and pass the **same** value on every run — it must stay
constant or previously encrypted credentials become unreadable.

### External database

Skip the embedded PostgreSQL and connect to your own (managed RDS, a separate
container, etc.). The engine still auto-migrates on boot:

```bash
docker run -d --name subkit -p 3000:3000 -v subkit-data:/data \
  -e DATABASE_URL="postgres://user:pass@db-host:5432/subkit" \
  -e MASTER_KEY="<your-64-hex-key>" \
  mikebild/subkit:latest
```

## Persistence & upgrades

State lives entirely in the `/data` volume. To upgrade, pull a newer tag and
recreate the container against the same volume — migrations apply automatically
on boot:

```bash
docker pull mikebild/subkit:latest
docker rm -f subkit
docker run -d --name subkit -p 3000:3000 -v subkit-data:/data mikebild/subkit:latest
```

## Notes & limits

- **Web-scraping connector**: Playwright browsers are not bundled (keeps the
  image lean). Scraping-dependent flows degrade gracefully; install browsers
  separately if you need them.
- **File scanning**: uploads are not virus-scanned by default — see
  [`production-hardening.md`](./production-hardening.md) before accepting
  untrusted uploads.
- **Single-node only**: the embedded-database image is not built for horizontal
  scaling. Use an external `DATABASE_URL` (and run multiple engine containers)
  or the systemd path for production scale.

## Publishing the image (maintainers)

Multi-arch (amd64 + arm64) build + push to Docker Hub:

```bash
docker login -u mikebild          # interactive; required once
bash scripts/docker-publish.sh    # tags :<version> + :latest
```

`PUSH=0`, `PLATFORMS=…`, and `IMAGE=…` env vars tune the build (see the script
header). After the first push, confirm the repository visibility is **public**
in Docker Hub → repository → Settings.
