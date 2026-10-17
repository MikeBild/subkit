ARG CLI_BINARIES_SOURCE=generated-cli

FROM oven/bun:1.4.0-debian@sha256:5bb0f9be3a1a36a03e27c9a9dd894a3b1ad26657155c7df4dda771e17bf872ef AS builder

WORKDIR /app

COPY . .

RUN set -eux; \
    for attempt in 1 2 3 4 5; do \
      bun install --frozen-lockfile && break; \
      if [ "$attempt" = 5 ]; then echo "bun install failed after $attempt attempts" >&2; exit 1; fi; \
      echo "bun install failed (attempt $attempt) — retrying"; sleep 5; \
    done

RUN bun run build:cockpit

RUN bun run build:clipper

RUN bun scripts/fetch-embedding-assets.ts

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

FROM builder AS generated-cli
RUN set -eux; \
    VERSION="${ENGINE_VERSION:-$(bun -e 'console.log(require("./package.json").version)')}"; \
    bun scripts/stage-cli-binaries.ts --dir /out/binaries --version "$VERSION"

FROM ${CLI_BINARIES_SOURCE} AS cli-binaries

FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e AS runtime

RUN set -eux; \
    for attempt in 1 2 3 4 5; do \
      apt-get -o Acquire::Retries=3 update && break; \
      echo "apt-get update failed (attempt $attempt) — retrying"; sleep 5; \
    done; \
    apt-get install -y --no-install-recommends curl ca-certificates libssl3t64 openssl; \
    rm -rf /var/lib/apt/lists/* /usr/lib/node_modules/npm; \
    rm -f /usr/bin/npm /usr/bin/npx

COPY --from=builder /out/engine /usr/local/bin/engine.bin
COPY --from=builder /out/sk /usr/local/bin/sk.bin
COPY --from=cli-binaries /out/binaries /usr/local/share/subkit/binaries
COPY deploy/docker/subkit-wrap.sh /usr/local/bin/subkit-wrap.sh
COPY deploy/docker/entrypoint.sh /usr/local/bin/subkit-entrypoint.sh
RUN chmod +x /usr/local/bin/engine.bin /usr/local/bin/sk.bin \
        /usr/local/bin/subkit-wrap.sh /usr/local/bin/subkit-entrypoint.sh \
    && ln -s /usr/local/bin/subkit-wrap.sh /usr/local/bin/engine \
    && ln -s /usr/local/bin/subkit-wrap.sh /usr/local/bin/sk \
    && mkdir -p /tmp/subkit-home /tmp/subkit-state \
    && chown -R pwuser:pwuser /tmp/subkit-home /tmp/subkit-state

ENV NODE_ENV=production \
    ENGINE_LISTEN_HOST=0.0.0.0 \
    HOME=/tmp/subkit-home \
    CONFIGURATION_DIRECTORY=/tmp/subkit-state \
    STATE_DIRECTORY=/tmp/subkit-state \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
    CMD curl -fsS http://127.0.0.1:3000/health >/dev/null \
      && curl -fsS http://127.0.0.1:3000/ready >/dev/null \
      || exit 1

USER pwuser
ENTRYPOINT ["/usr/local/bin/subkit-entrypoint.sh"]
