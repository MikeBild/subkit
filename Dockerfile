ARG CLI_BINARIES_SOURCE=generated-cli

FROM docker.io/oven/bun:1.4.5-debian@sha256:3dddea58e1f8f2240eca906b023fedb944f9a8352515a35309fd0c879fe00aaa AS builder

WORKDIR /app

COPY . .

RUN set -eu; \
    mkdir -p /out; \
    LC_ALL=C TZ=UTC0 tar --sort=name --format=posix --pax-option=delete=atime,delete=ctime \
      --mtime='@0' --owner=0 --group=0 --numeric-owner \
      -cf /tmp/subkit-build-context.tar .; \
    LC_ALL=C TZ=UTC0 tar -tvf /tmp/subkit-build-context.tar > /out/BUILD_CONTEXT_MANIFEST.txt; \
    sha256sum /tmp/subkit-build-context.tar | awk '{print $1}' > /out/BUILD_CONTEXT_DIGEST; \
    test "$(wc -l < /out/BUILD_CONTEXT_MANIFEST.txt)" -gt 0; \
    test "$(wc -c < /out/BUILD_CONTEXT_DIGEST)" -eq 65; \
    rm /tmp/subkit-build-context.tar

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
    bun build apps/engine/src/index.ts apps/engine/src/embeddings/embedding-worker.ts --compile --root . \
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
RUN bun scripts/install-rcodesign.ts /usr/local/bin
RUN set -eux; \
    VERSION="${ENGINE_VERSION:-$(bun -e 'console.log(require("./package.json").version)')}"; \
    bun scripts/stage-cli-binaries.ts --dir /out/binaries --version "$VERSION"

FROM ${CLI_BINARIES_SOURCE} AS cli-binaries

FROM docker.io/library/ubuntu:24.04@sha256:68ee22004a9109b44973313b02ff7b1de250f1de0f5ecb628d73f579aaff33ac AS runtime

RUN set -eux; \
    for attempt in 1 2 3 4 5; do \
      apt-get -o Acquire::Retries=3 update && break; \
      echo "apt-get update failed (attempt $attempt) — retrying"; sleep 5; \
    done; \
    DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl tzdata; \
    DEBIAN_FRONTEND=noninteractive apt-get upgrade -y --no-install-recommends; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd --gid 1001 subkit; \
    useradd --uid 1001 --gid 1001 --no-create-home --home-dir /tmp/subkit-home \
      --shell /usr/sbin/nologin subkit

COPY --from=builder /out/engine /usr/local/bin/engine.bin
COPY --from=builder /out/sk /usr/local/bin/sk.bin
COPY --from=builder /out/BUILD_CONTEXT_MANIFEST.txt /usr/local/share/subkit/BUILD_CONTEXT_MANIFEST.txt
COPY --from=builder /out/BUILD_CONTEXT_DIGEST /usr/local/share/subkit/BUILD_CONTEXT_DIGEST
COPY --from=cli-binaries /out/binaries /usr/local/share/subkit/binaries
COPY LICENSE /usr/local/share/subkit/LICENSE
COPY --from=builder /out/THIRD_PARTY_NOTICES.txt /usr/local/share/subkit/THIRD_PARTY_NOTICES.txt
COPY deploy/docker/SOURCE_OFFER.txt /usr/local/share/subkit/SOURCE_OFFER.txt
RUN set -eu; \
    out=/usr/local/share/subkit/BASE_IMAGE_INVENTORY.txt; \
    { \
      echo "Base image OS packages: package, version, source package, source version, license file"; \
      dpkg-query -W -f='${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\t${Package}\n' \
        | while IFS="$(printf '\t')" read -r pkg ver src srcver name; do \
            lic="/usr/share/doc/$name/copyright"; [ -f "$lic" ] || lic="missing"; \
            printf '%s\t%s\t%s\t%s\t%s\n' "$pkg" "$ver" "$src" "$srcver" "$lic"; \
          done | LC_ALL=C sort; \
    } > "$out"; \
    test -s "$out"
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
    && chown -R subkit:subkit /tmp/subkit-home /tmp/subkit-state

ENV NODE_ENV=production \
    ENGINE_LISTEN_HOST=0.0.0.0 \
    HOME=/tmp/subkit-home \
    CONFIGURATION_DIRECTORY=/tmp/subkit-state \
    STATE_DIRECTORY=/tmp/subkit-state

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=5 \
    CMD curl -fsS http://127.0.0.1:3000/health >/dev/null \
      && curl -fsS http://127.0.0.1:3000/ready >/dev/null \
      || exit 1

USER subkit
ENTRYPOINT ["/usr/local/bin/subkit-entrypoint.sh"]
