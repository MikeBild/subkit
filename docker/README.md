# docker/

4.2.0 systemd-native deploys retired the engine container; the only
artifact left here is `Dockerfile.agent`, which packages the
**tunnel-agent** for customers who run it inside their own
infrastructure (Kubernetes, customer-owned VPCs).

For the engine itself:

- **Local dev** — `docker compose up -d` brings up postgres only.
  `bun run dev` runs the engine on the host. See the root `docker-compose.yml`.
- **Production** — `scripts/deploy.sh` cross-compiles the engine
  (`bun build --compile --target=bun-linux-x64`), `scp`s the binary,
  and `systemctl restart`s the unit. See `deploy/systemd/subkit-engine.service`.

The tunnel-agent's docker image still ships per release because it's a
customer-distributed artifact (`docker pull subkit/tunnel-agent:<ver>`),
not part of the subkit deployment surface itself.
