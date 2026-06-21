# docker/

The engine ships an **all-in-one image** (`mikebild/subkit`) that bundles the
engine + PostgreSQL for the easiest possible customer onramp:

```bash
docker run -d --name subkit -p 3000:3000 -v subkit-data:/data mikebild/subkit:latest
```

- **Image build** — the root [`Dockerfile`](../Dockerfile) (multi-stage: a bun
  builder compiles the engine + `sk` binaries, a `postgres:18` runtime stage
  runs them). Boot logic lives in [`../deploy/docker/entrypoint.sh`](../deploy/docker/entrypoint.sh).
- **Customer guide** — [`../docs/operations/docker.md`](../docs/operations/docker.md):
  quick start, admin key, LLM wiring, external-DB mode, persistence, limits.
- **Publish (multi-arch)** — [`../scripts/docker-publish.sh`](../scripts/docker-publish.sh).

For local development, `docker compose up -d` brings up postgres only; `bun run dev`
runs the engine on the host. See the root `docker-compose.yml`.
