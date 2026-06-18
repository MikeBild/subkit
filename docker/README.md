# docker/

The engine ships an **all-in-one image** (`mikebild/subkit`) that bundles the
engine + PostgreSQL for the easiest possible customer onramp:

```bash
docker run -d --name subkit -p 3000:3000 -v subkit-data:/data mikebild/subkit:latest
```

- **Image build** — the root [`Dockerfile`](../Dockerfile) (multi-stage: a bun
  builder compiles the engine + `sk` binaries, a `postgres:16` runtime stage
  runs them). Boot logic lives in [`../deploy/docker/entrypoint.sh`](../deploy/docker/entrypoint.sh).
- **Customer guide** — [`../docs/operations/docker.md`](../docs/operations/docker.md):
  quick start, admin key, LLM wiring, external-DB mode, persistence, limits.
- **Publish (multi-arch)** — [`../scripts/docker-publish.sh`](../scripts/docker-publish.sh).

Other ways to run the engine:

- **Local dev** — `docker compose up -d` brings up postgres only; `bun run dev`
  runs the engine on the host. See the root `docker-compose.yml`.
- **Production (systemd-native)** — `scripts/deploy.sh` cross-compiles the
  engine (`bun build --compile --target=bun-linux-x64`), `scp`s the binary, and
  `systemctl restart`s the unit. See [`../docs/operations/deploy.md`](../docs/operations/deploy.md)
  and `deploy/systemd/subkit-engine.service`. Prefer this for production scale.
