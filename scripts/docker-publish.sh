#!/usr/bin/env bash
# Build + push the all-in-one subkit image to Docker Hub for amd64 + arm64.
#
# Prerequisites (run once, interactively — this script can't do it for you):
#   docker login -u <your-dockerhub-user>
#
# Usage:
#   bash scripts/docker-publish.sh                  # tags :<version> + :latest
#   IMAGE=myuser/subkit bash scripts/docker-publish.sh
#   PLATFORMS=linux/amd64 bash scripts/docker-publish.sh   # single-arch
#   PUSH=0 bash scripts/docker-publish.sh           # build only, no push
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

IMAGE="${IMAGE:-mikebild/subkit}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
PUSH="${PUSH:-1}"
# Mirror the Dockerfile's version read (bun, not node) so the publish
# script runs in the same bun-only toolchain as the build.
VERSION="${VERSION:-$(bun -e 'console.log(require("./package.json").version)')}"

echo "[publish] image=$IMAGE version=$VERSION platforms=$PLATFORMS push=$PUSH"

# A buildx builder with the docker-container driver is required for
# multi-arch + push. Reuse one if it already exists.
if ! docker buildx inspect subkit-builder >/dev/null 2>&1; then
  docker buildx create --name subkit-builder --driver docker-container --use >/dev/null
else
  docker buildx use subkit-builder
fi
docker buildx inspect --bootstrap >/dev/null

OUTPUT_FLAG="--push"
if [ "$PUSH" != "1" ]; then
  # Multi-arch images can't load into the local daemon; build without
  # output when not pushing (validates both arches compile).
  case "$PLATFORMS" in
    *,*) OUTPUT_FLAG="" ;;        # multi-arch → no load
    *)   OUTPUT_FLAG="--load" ;;  # single-arch → load locally
  esac
fi

docker buildx build \
  --platform "$PLATFORMS" \
  --build-arg "ENGINE_VERSION=$VERSION" \
  -t "$IMAGE:$VERSION" \
  -t "$IMAGE:latest" \
  $OUTPUT_FLAG \
  .

echo "[publish] done: $IMAGE:$VERSION and $IMAGE:latest"
if [ "$PUSH" = "1" ]; then
  echo "[publish] verify the repo is PUBLIC in Docker Hub → repository settings → visibility."
fi
