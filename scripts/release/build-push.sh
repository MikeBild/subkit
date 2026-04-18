#!/usr/bin/env bash
#
# Build and push the engine + migrate images to DigitalOcean
# Container Registry. Mirrors the `build-and-push` job body in
# `.github/workflows/release.yml` so local and CI produce byte-for-byte
# comparable image digests (same Dockerfile, same platform, same tags).
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
#
# Serial build+push is intentional. Docker Desktop's internal HTTP
# proxy (192.168.65.1:3128) drops large blob uploads when two buildx
# pushes run concurrently; we saw that today.

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
  )
  # engine uses ENGINE_VERSION build arg to stamp /v1/health. migrate
  # doesn't need it — migrations don't expose a version.
  if [ "$image" = "engine" ]; then
    args+=(--build-arg "ENGINE_VERSION=$tag")
  fi

  msg "building + pushing $image:$tag"
  if ! docker buildx build "${args[@]}" --push "$REPO_ROOT"; then
    err "buildx failed — re-authing DOCR and retrying once"
    login_docr
    docker buildx build "${args[@]}" --push "$REPO_ROOT"
  fi
}

login_docr
build_push "$VERSION" docker/Dockerfile.engine engine
build_push "$VERSION" docker/Dockerfile.migrate migrate

msg "pushed registry.digitalocean.com/subkit/{engine,migrate}:$VERSION and :latest"
