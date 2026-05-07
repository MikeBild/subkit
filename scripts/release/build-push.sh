#!/usr/bin/env bash
#
# Build and push the engine image to DigitalOcean Container Registry.
# Mirrors the `build-and-push` job body in `.github/workflows/release.yml`
# so local and CI produce byte-for-byte comparable image digests (same
# Dockerfile, same platform, same tags).
#
# The migrate image was retired in #149 — migrations + seed are
# embedded in the engine binary and run in-process on boot.
#
# Usage:
#   VERSION=1.6.7 scripts/release/build-push.sh
#   # or from the repo root, read manifest:
#   scripts/release/build-push.sh           # uses version.sh current_version
#
# Required:
#   doctl authenticated with a PAT that has `registry:update` scope
#   (read-only PATs 403 on push — this is the one footgun the operator
#   hit repeatedly this afternoon).

set -euo pipefail

_SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=./version.sh
source "$_SCRIPT_DIR/version.sh"

REPO_ROOT=$(cd "$_SCRIPT_DIR/../.." && pwd)
REGISTRY="${REGISTRY:-registry.digitalocean.com}"

VERSION="${VERSION:-$(current_version)}"
: "${VERSION:?VERSION could not be resolved; set it or populate .release-please-manifest.json}"

msg() { printf '\033[1;36m[release/build-push]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[release/build-push]\033[0m %s\n' "$*" >&2; }

# `doctl registry login` caches a scoped docker credential for ~30 min.
# If buildx hits 401 mid-push (token expired or PAT rotated), retry the
# login once and reattempt. This is the CI flow too, minus the retry,
# since GitHub Actions runners get a fresh token per workflow.
login_docr() {
  msg "doctl registry login"
  doctl registry login --expiry-seconds 1800 >/dev/null
}

build_push() {
  local tag="$1"; local dockerfile="$2"; local image="$3"
  local args=(
    --platform linux/amd64
    -f "$REPO_ROOT/$dockerfile"
    -t "$REGISTRY/subkit/$image:$tag"
    -t "$REGISTRY/subkit/$image:latest"
    --build-arg "ENGINE_VERSION=$tag"
  )

  msg "building + pushing $image:$tag"
  if ! docker buildx build "${args[@]}" --push "$REPO_ROOT"; then
    err "buildx failed — re-authing DOCR and retrying once"
    login_docr
    docker buildx build "${args[@]}" --push "$REPO_ROOT"
  fi
}

login_docr
build_push "$VERSION" docker/Dockerfile.engine engine

msg "pushed registry.digitalocean.com/subkit/engine:$VERSION and :latest"
