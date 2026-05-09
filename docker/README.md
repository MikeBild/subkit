# docker/

4.2.0 systemd-native deploys retired the engine container. There are
no shipped Dockerfiles in this directory anymore.

For the engine itself:

- **Local dev** — `docker compose up -d` brings up postgres only.
  `bun run dev` runs the engine on the host. See the root `docker-compose.yml`.
- **Production** — `scripts/deploy.sh` cross-compiles the engine
  (`bun build --compile --target=bun-linux-x64`), `scp`s the binary,
  and `systemctl restart`s the unit. See `deploy/systemd/subkit-engine.service`.
