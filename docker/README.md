# Subkit Docker stack

A one-command local deployment of the Subkit workflow engine.

## Quick start

From the repo root:

```sh
docker compose up -d --build
# or: bun run compose:up
```

This will:

1. Create `.env` from `.env.example` with an auto-generated `MASTER_KEY` if missing (when using `bun run compose:up`).
2. Build the engine, migrate, and seed images.
3. Start PostgreSQL and wait for it to become healthy.
4. Run the one-shot migration container.
5. Seed the default tenant, admin user, and dev fixtures.
6. Start the engine service.

The engine binds `http://localhost:3000`. Tunnel WebSocket listens on `3001`.

### Required env

At minimum set `MASTER_KEY` in `.env` to a real 64-hex string:

```sh
openssl rand -hex 32
```

Or use `bun run compose:up` which auto-generates it on first run.

## Profiles

The default profile runs `postgres`, `migrate`, `seed`, `engine`.

| Profile   | Command                                              | Adds                        |
|-----------|------------------------------------------------------|-----------------------------|
| `storage` | `docker compose --profile storage up -d` | MinIO on `:9000` + `:9001` |
| `tunnel`  | `docker compose --profile tunnel up -d`  | Tunnel agent container      |

## Common operations

```sh
# tail engine logs
docker compose logs -f engine

# check health
curl http://localhost:3000/v1/health

# run the docker-backed end-to-end acceptance gate
bun run test:e2e:docker

# reuse an already running stack and leave it up afterwards
SUBKIT_DOCKER_SKIP_COMPOSE=1 SUBKIT_DOCKER_KEEP_STACK=1 bun run test:e2e:docker

# shell into engine
docker compose exec engine sh

# stop and clean up (volumes persist)
docker compose down

# full reset (drops DB + blob volume)
docker compose down -v
```

`test:e2e:docker` also accepts:

- `SUBKIT_DOCKER_BASE_URL` to target a non-default engine URL.
- `SUBKIT_DOCKER_API_KEY` to reuse an existing admin key instead of issuing one through `docker compose run`.
- `SUBKIT_DOCKER_TENANT` to mint the admin key for a different tenant slug.

## Production readiness notes

- **Pin image digests.** The compose file uses floating tags (`postgres:16-alpine`, `minio/minio:latest`). Replace with digests (`postgres:16-alpine@sha256:...`) before production.
- **MASTER_KEY handling.** Never commit `.env`. Mount secrets from your orchestrator's secret store (Kubernetes Secret, AWS SSM, Vault). Rotating `MASTER_KEY` invalidates every previously encrypted credential — re-seed afterwards.
- **Postgres.** The default uses the in-container `postgres:16-alpine` with `subkit`/`subkit` creds. Replace with a managed DB (RDS, Cloud SQL, Neon) for production and drop the `postgres` service from the compose file.
- **Object storage.** `FILE_STORAGE_ENABLED=false` falls back to a named volume (`subkit_blobs` → `/var/data/blobs` inside the engine). For multi-node deployments either switch to MinIO (`--profile storage`) or point `S3_*` env at an external S3 bucket.
- **Resource limits.** The compose file has `mem_limit` / `cpus` as commented references. Enable them in a swarm/k8s deployment where they are enforced.
- **Ports.** `5432` is exposed on the host for local tooling — bind it to `127.0.0.1` or remove the mapping in production.
- **Healthchecks.** All services have healthchecks. The engine reports DB connectivity at `/v1/health`:

  ```json
  {"status":"ok","version":"0.0.0","db_connected":true,"uptime_seconds":5}
  ```

- **Logging.** Every service uses `json-file` with 10 MiB × 3 rotation. In production ship logs to a centralized collector (Loki, Datadog, CloudWatch) via the daemon's log driver.
