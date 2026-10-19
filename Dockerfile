ARG CLI_BINARIES_SOURCE=generated-cli

FROM docker.io/oven/bun:1.4.0-debian@sha256:5bb0f9be3a1a36a03e27c9a9dd894a3b1ad26657155c7df4dda771e17bf872ef AS builder

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
      --metafile=/out/engine.json \
      --outfile /out/engine; \
    bun build apps/sk/src/index.ts --compile \
      --external cpu-features \
      --define "process.env.NODE_ENV=process.env.NODE_ENV" \
      --define "BUILD_VERSION=\"$VERSION\"" \
      --metafile=/out/sk.json \
      --outfile /out/sk

RUN NODE_ENV=production bunx vite build --config apps/cockpit/vite.config.ts \
      --sourcemap --outDir /out/notice-cockpit && \
    bun scripts/third-party-notices.ts /out/engine.json /out/sk.json \
      /out/notice-cockpit/assets/*.map > /out/THIRD_PARTY_NOTICES.txt

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
    apt-get purge -y gstreamer1.0-plugins-bad libgstreamer-plugins-bad1.0-0; \
    apt-get install -y --no-install-recommends --only-upgrade \
      bsdutils coreutils diffutils dirmngr gpg \
      gpg-agent gpgconf gpgv gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
      gzip libaom3 libattr1 libblkid1 libbz2-1.0 \
      libc-bin libc6 libde265-0 libevent-2.1-7t64 libexpat1 \
      libfdisk1 libfreetype6 libgcrypt20 libglib2.0-0t64 libgstreamer-gl1.0-0 \
      libgstreamer-plugins-base1.0-0 libgstreamer-plugins-good1.0-0 libmount1 libncurses6 libncursesw6 \
      libp11-kit0 libpam-modules libpam-modules-bin libpam-runtime libpam-systemd \
      libpam0g libperl5.38t64 libpng16-16t64 libpython3.12-minimal libpython3.12-stdlib \
      librabbitmq4 librsvg2-2 libsmartcols1 libsoup-3.0-0 libsoup-3.0-common \
      libsqlite3-0 libssh-4 libssh-gcrypt-4 libsystemd-shared libsystemd0 \
      libtinfo6 libudev1 libuuid1 libx11-6 libx11-data \
      libx11-xcb1 libxml2 libxpm4 mount ncurses-base \
      ncurses-bin openssh-client perl perl-base perl-modules-5.38 \
      python3.12 python3.12-minimal systemd systemd-dev systemd-sysv \
      tar util-linux zlib1g; \
    rm -rf /var/lib/apt/lists/* /usr/lib/node_modules/npm; \
    rm -f /usr/bin/npm /usr/bin/npx

COPY --from=builder /out/engine /usr/local/bin/engine.bin
COPY --from=builder /out/sk /usr/local/bin/sk.bin
COPY --from=cli-binaries /out/binaries /usr/local/share/subkit/binaries
COPY LICENSE /usr/local/share/subkit/LICENSE
COPY --from=builder /out/THIRD_PARTY_NOTICES.txt /usr/local/share/subkit/THIRD_PARTY_NOTICES.txt
COPY deploy/docker/subkit-wrap.sh /usr/local/bin/subkit-wrap.sh
COPY deploy/docker/entrypoint.sh /usr/local/bin/subkit-entrypoint.sh
RUN cp /usr/local/share/subkit/LICENSE /usr/local/share/subkit/binaries/LICENSE \
    && cp /usr/local/share/subkit/THIRD_PARTY_NOTICES.txt /usr/local/share/subkit/binaries/THIRD_PARTY_NOTICES.txt \
    && cd /usr/local/share/subkit/binaries \
    && awk '$2 != "LICENSE" && $2 != "THIRD_PARTY_NOTICES.txt"' SHA256SUMS > SHA256SUMS.next \
    && sha256sum LICENSE THIRD_PARTY_NOTICES.txt >> SHA256SUMS.next \
    && mv SHA256SUMS.next SHA256SUMS

RUN chmod 755 /usr/local/bin/engine.bin /usr/local/bin/sk.bin \
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
