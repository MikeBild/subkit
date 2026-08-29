# subkit — application-complete image (external PostgreSQL required).
#
# The image contains the engine, Cockpit, migrations, every supported `sk`
# client artifact and Chromium. PostgreSQL deliberately stays outside the
# application container; DATABASE_URL (or DATABASE_URL_FILE) is mandatory.
#
# Build (single-arch, local):   docker build -t subkit:local .
# Publish (multi-arch):         bash scripts/docker-publish.sh

ARG CLI_BINARIES_SOURCE=generated-cli

# ---------------------------------------------------------------------------
# Stage 1 — builder: compile the engine + sk CLI to self-contained binaries.
# buildx runs this stage natively per target arch, so `bun build --compile`
# emits a binary for the runtime arch with no cross-compile flag needed.
# ---------------------------------------------------------------------------
FROM oven/bun:1.4.0-debian@sha256:5bb0f9be3a1a36a03e27c9a9dd894a3b1ad26657155c7df4dda771e17bf872ef AS builder

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

# Build and embed the browser Cockpit from the same source and lockfile as the
# engine binary. The compiled engine has no runtime dependency on Node or Vite.
RUN bun run build:cockpit

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
      --external cpu-features \
      --define "process.env.NODE_ENV=process.env.NODE_ENV" \
      --define "BUILD_VERSION=\"$VERSION\"" \
      --outfile /out/engine; \
    bun build apps/sk/src/index.ts --compile \
      --external cpu-features \
      --define "process.env.NODE_ENV=process.env.NODE_ENV" \
      --define "BUILD_VERSION=\"$VERSION\"" \
      --outfile /out/sk

# Local-build fallback: stage all five client-platform `sk` binaries plus
# SHA256SUMS. Release builds replace this stage with a named build context
# containing the exact binaries produced natively by the release matrix.
FROM builder AS generated-cli
RUN set -eux; \
    VERSION="${ENGINE_VERSION:-$(bun -e 'console.log(require("./package.json").version)')}"; \
    bun scripts/stage-cli-binaries.ts --dir /out/binaries --version "$VERSION"

# `generated-cli` keeps `docker build .` self-contained. CI passes
# CLI_BINARIES_SOURCE=cli_binaries and a same-named additional context, so the
# image serves byte-for-byte the signed/checksummed GitHub Release artifacts.
FROM ${CLI_BINARIES_SOURCE} AS cli-binaries

# ---------------------------------------------------------------------------
# Stage 2 — runtime: Playwright provides the exact Chromium build and its OS
# libraries used by browser-backed engine workflows.
# ---------------------------------------------------------------------------
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e AS runtime

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
COPY --from=cli-binaries /out/binaries /usr/local/share/subkit/binaries
COPY deploy/docker/subkit-wrap.sh /usr/local/bin/subkit-wrap.sh
COPY deploy/docker/entrypoint.sh /usr/local/bin/subkit-entrypoint.sh
RUN chmod +x /usr/local/bin/engine.bin /usr/local/bin/sk.bin \
        /usr/local/bin/subkit-wrap.sh /usr/local/bin/subkit-entrypoint.sh \
    && ln -s /usr/local/bin/subkit-wrap.sh /usr/local/bin/engine \
    && ln -s /usr/local/bin/subkit-wrap.sh /usr/local/bin/sk \
    && mkdir -p /data/config /data/blobs /data/home \
    && chown -R pwuser:pwuser /data

# Single /data volume holds config (incl. the persisted MASTER_KEY), file blobs
# and the sk CLI profile, so one volume mount preserves all application state
# across restarts. HOME points the sk profile (~/.sk) onto the volume so an
# in-container `docker exec … sk init`/login stays usable after restarts.
ENV NODE_ENV=production \
    ENGINE_LISTEN_HOST=0.0.0.0 \
    SUBKIT_CONFIG=/data/config/subkit.config.json \
    SUBKIT_BOOTSTRAP_TOKEN_FILE=/data/config/bootstrap.token \
    HOME=/data/home \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 3000
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
    CMD curl -fsS http://127.0.0.1:3000/health >/dev/null \
      && curl -fsS http://127.0.0.1:3000/ready >/dev/null \
      || exit 1

USER pwuser
ENTRYPOINT ["/usr/local/bin/subkit-entrypoint.sh"]
