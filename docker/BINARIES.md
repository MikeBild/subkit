# Subkit Binaries

`bun build --compile` produces three single-file native binaries in the current repo.

| Binary             | Source entry                       | Build command          |
| ------------------ | ---------------------------------- | ---------------------- |
| `dist/engine`      | `apps/engine/src/index.ts`         | `bun run build:engine` |
| `dist/sk`          | `apps/sk/src/index.ts`             | `bun run build:sk`     |
| `dist/tunnel-agent`| `apps/agent/src/index.ts`          | `bun run build:agent`  |
| all three          | —                                  | `bun run build:all`    |

## macOS 26.2 AMFI rejection

On macOS 26.2 the kernel's Apple Mobile File Integrity (AMFI) checks reject
locally compiled bun binaries with `Killed: 9` and a system log entry along
the lines of `AMFI: code signature not valid`. The binaries themselves are
fine — they just need an ad-hoc signature so AMFI lets them load.

Run after each build:

```sh
codesign --force --sign - --timestamp=none dist/engine
codesign --force --sign - --timestamp=none dist/sk
codesign --force --sign - --timestamp=none dist/tunnel-agent
```

Verify with `codesign -dv dist/engine 2>&1 | head -3`. If the parent bundle
is also flagged, `xattr -dr com.apple.quarantine dist/` clears the
quarantine attribute set by the downloaded `bun` toolchain.

This is a developer-machine workaround only — the production Linux Docker
images below run unmodified.

## Docker engine image

`docker/Dockerfile.engine` builds a minimal Linux container around the
compiled engine binary. Build and run from the repo root:

```sh
docker build -f docker/Dockerfile.engine -t subkit-engine:dev .
docker run --rm -p 8080:8080 \
  -e DATABASE_URL=postgres://subkit:subkit@db:5432/subkit \
  -e MASTER_KEY=00000000000000000000000000000000000000000000000000000000000000aa \
  subkit-engine:dev
```

For local development with Postgres + pg-boss + minio in the same
network, prefer `bun run compose:up` which spins up the full
`docker-compose.yml` stack and tails logs via `bun run compose:logs`.
