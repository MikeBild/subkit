# subkit — all-in-one image (engine + bundled PostgreSQL).
#
# Designed for the easiest possible customer onramp: one `docker run`
# yields a working engine with zero external dependencies. The container
# boots an embedded PostgreSQL, auto-generates+persists a MASTER_KEY, and
# starts the engine bound to 0.0.0.0 so `-p 3000:3000` is reachable.
#
# Supply your own DATABASE_URL to skip the embedded PostgreSQL and point
# at an external database (the production-shaped topology). See
# docs/operations/docker.md for the full contract.
#
# Build (single-arch, local):   docker build -t subkit:local .
# Publish (multi-arch):         bash scripts/docker-publish.sh

# ---------------------------------------------------------------------------
# Stage 1 — builder: compile the engine + sk CLI to self-contained binaries.
# buildx runs this stage natively per target arch, so `bun build --compile`
# emits a binary for the runtime arch with no cross-compile flag needed.
# ---------------------------------------------------------------------------
FROM oven/bun:1-debian AS builder

WORKDIR /app

# Full source is needed: a workspace monorepo with patchedDependencies and
# JSON/text assets bundled into the binary at build time. .dockerignore keeps
# node_modules/dist/.git out of the context.
COPY . .

# --frozen-lockfile matches the committed bun.lock. setup-hooks postinstall
# self-skips when there's no .git (it's there inside the image build).
# Retry: under buildx/QEMU emulation, extracting large optional native
# tarballs (e.g. @img/sharp-libvips-*) occasionally fails transiently
# ("Fail extracting tarball"). A bounded retry makes the layer reproducible.
RUN set -eux; \
    for attempt in 1 2 3 4 5; do \
      bun install --frozen-lockfile && break; \
      if [ "$attempt" = 5 ]; then echo "bun install failed after $attempt attempts" >&2; exit 1; fi; \
      echo "bun install failed (attempt $attempt) — retrying"; sleep 5; \
    done

# ssh2 pulls an OPTIONAL `cpu-features` native addon. It is not built in this
# image (nor on the dev mac), so its `.node` is absent; left in place, the
# `bun build --compile` below fails trying to bundle the missing addon. Remove
# it so the bundle matches the working mac build (ssh2 runs fine without it).
RUN rm -rf node_modules/cpu-features

# Fetch the embedded-embedding assets (MiniLM model + tokenizer +
# onnxruntime-web WASM) that the compile step inlines into the binary. Mirrors
# the `bun scripts/fetch-embedding-assets.ts` prefix in package.json's
# build:engine recipe; needs node_modules (onnxruntime-web) from the install
# above and network access to the pinned model id.
RUN bun scripts/fetch-embedding-assets.ts

# ENGINE_VERSION stamps the binary's reported version (falls back to the
# package.json value). Mirrors package.json's build:engine / build:sk recipes
# minus the macOS codesign step. The NODE_ENV define is intentionally a no-op
# substitution so NODE_ENV stays runtime-dynamic rather than baked in.
ARG ENGINE_VERSION
RUN set -eux; \
    VERSION="${ENGINE_VERSION:-$(bun -e 'console.log(require("./package.json").version)')}"; \
    bun build apps/engine/src/index.ts --compile \
      --define "process.env.NODE_ENV=process.env.NODE_ENV" \
      --define "BUILD_VERSION=\"$VERSION\"" \
      --outfile /out/engine; \
    bun build apps/sk/src/index.ts --compile \
      --define "process.env.NODE_ENV=process.env.NODE_ENV" \
      --define "BUILD_VERSION=\"$VERSION\"" \
      --outfile /out/sk

# Stage all five client-platform `sk` binaries + SHA256SUMS so the running
# engine can serve the matching CLI for ANY client via GET /install/{asset}
# (SUBKIT_BINARIES_DIR). This is what makes `curl <engine>/install | bash`
# work without any github.com egress — the private-repo GitHub Release
# fallback in the install script is never on the critical path. Single source
# of truth for on-disk names + sums format: scripts/stage-cli-binaries.ts.
RUN set -eux; \
    VERSION="${ENGINE_VERSION:-$(bun -e 'console.log(require("./package.json").version)')}"; \
    bun scripts/stage-cli-binaries.ts --dir /out/binaries --version "$VERSION"

# ---------------------------------------------------------------------------
# Stage 2 — runtime: postgres:18 base bundles PostgreSQL 18, initdb, gosu,
# and a glibc userland for the bun-compiled binary. We only add curl +
# ca-certificates (healthcheck + outbound TLS to LLM providers).
# ---------------------------------------------------------------------------
FROM postgres:18-bookworm AS runtime

# Retry apt-get update: under buildx/QEMU multi-arch builds the InRelease
# fetch occasionally fails transiently ("is not signed"). Acquire::Retries
# plus an outer loop make the layer reproducible.
RUN set -eux; \
    for attempt in 1 2 3 4 5; do \
      apt-get -o Acquire::Retries=3 update && break; \
      echo "apt-get update failed (attempt $attempt) — retrying"; sleep 5; \
    done; \
    apt-get install -y --no-install-recommends curl ca-certificates; \
    rm -rf /var/lib/apt/lists/*

# Real compiled binaries land as *.bin; `engine` / `sk` on PATH are thin
# wrappers that source the persisted bootstrap env so `docker exec` works.
COPY --from=builder /out/engine /usr/local/bin/engine.bin
COPY --from=builder /out/sk /usr/local/bin/sk.bin
# All-platform `sk` binaries served by GET /install/{asset}. SUBKIT_BINARIES_DIR
# defaults to this path (install-binary.ts), so no extra ENV is needed.
COPY --from=builder /out/binaries /usr/local/share/subkit/binaries
COPY deploy/docker/subkit-wrap.sh /usr/local/bin/subkit-wrap.sh
COPY deploy/docker/entrypoint.sh /usr/local/bin/subkit-entrypoint.sh
RUN chmod +x /usr/local/bin/engine.bin /usr/local/bin/sk.bin \
        /usr/local/bin/subkit-wrap.sh /usr/local/bin/subkit-entrypoint.sh \
    && ln -s /usr/local/bin/subkit-wrap.sh /usr/local/bin/engine \
    && ln -s /usr/local/bin/subkit-wrap.sh /usr/local/bin/sk

# Single /data volume holds pgdata + config (incl. the persisted MASTER_KEY)
# + file blobs + the sk CLI profile, so one volume mount preserves all state
# across restarts. HOME points the sk profile (~/.sk) onto the volume so an
# in-container `docker exec … sk init`/login stays usable after restarts.
ENV NODE_ENV=production \
    ENGINE_LISTEN_HOST=0.0.0.0 \
    PGDATA=/data/pgdata \
    SUBKIT_CONFIG=/data/config/subkit.config.json \
    SUBKIT_BOOTSTRAP_TOKEN_FILE=/data/config/bootstrap.token \
    HOME=/data/home

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
    CMD curl -fsS http://127.0.0.1:3000/v1/health || exit 1

ENTRYPOINT ["/usr/local/bin/subkit-entrypoint.sh"]
