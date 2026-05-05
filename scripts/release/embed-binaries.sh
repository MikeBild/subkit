#!/usr/bin/env bash
#
# Populate `docker/binaries/` with the per-platform `sk` and `tunnel-agent`
# binaries plus a matching SHA256SUMS, ready for the `engine-with-cli`
# Dockerfile target to COPY into /usr/local/share/subkit/binaries/.
#
# Two modes:
#
#   --from-run <RUN_ID>   (CI mode)
#       Downloads artifacts from the named GitHub Actions run via
#       `gh run download`. Used by the release workflow after
#       build-cli-binaries finishes.
#
#   --from-local          (dev mode)
#       Reuses already-built host binaries from dist/sk and
#       dist/tunnel-agent (single-platform). Useful for smoke-testing the
#       engine-with-cli image locally without the full release matrix.
#
# In both modes the output is the same shape:
#   docker/binaries/
#     ├── sk_darwin_arm64
#     ├── sk_darwin_x64
#     ├── sk_linux_arm64
#     ├── sk_linux_x64
#     ├── sk_windows_x64.exe
#     ├── tunnel-agent_darwin_arm64
#     ├── tunnel-agent_darwin_x64
#     ├── tunnel-agent_linux_arm64
#     ├── tunnel-agent_linux_x64
#     ├── tunnel-agent_windows_x64.exe
#     └── SHA256SUMS
#
# The SHA256SUMS line format matches what the release workflow attaches
# to the GitHub Release, so the engine's /install/sha256sums route and
# the GitHub fallback expose identical content for the same tag.

set -euo pipefail

_SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$_SCRIPT_DIR/../.." && pwd)

OUT_DIR="$REPO_ROOT/docker/binaries"
MODE=""
RUN_ID=""

msg() { printf '\033[1;36m[release/embed-binaries]\033[0m %s\n' "$*"; }
err() { printf '\033[1;31m[release/embed-binaries]\033[0m %s\n' "$*" >&2; }

usage() {
  cat <<EOF
Usage: $0 (--from-run <RUN_ID> | --from-local) [--out <DIR>]

  --from-run <RUN_ID>   download GitHub Actions artifacts for the given run
  --from-local          use already-built host binaries from dist/
  --out <DIR>           output directory (default: docker/binaries)
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --from-run)
      MODE="run"
      RUN_ID="${2:-}"
      shift 2
      ;;
    --from-local)
      MODE="local"
      shift
      ;;
    --out)
      OUT_DIR="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage; exit 0
      ;;
    *)
      err "unknown arg: $1"
      usage; exit 2
      ;;
  esac
done

if [ -z "$MODE" ]; then
  err "must pass --from-run <RUN_ID> or --from-local"
  usage; exit 2
fi

# Clear stale artifacts but keep the directory itself (and any committed
# `.gitkeep`) so the docker build context layout stays stable.
mkdir -p "$OUT_DIR"
find "$OUT_DIR" -mindepth 1 -maxdepth 1 ! -name '.gitkeep' -exec rm -rf {} +

# All platform combos that build-cli-binaries produces. Mirrored from
# .github/workflows/release.yml — keep in sync if the matrix changes.
COMBOS=(
  "darwin x64"
  "darwin arm64"
  "linux x64"
  "linux arm64"
  "windows x64"
)

# ── mode: run ───────────────────────────────────────────────────────────
#
# Mirrors the gh-run-download retry block in release.yml's
# publish-release job (artifacts/v4 transient blob errors require
# per-artifact retries instead of bulk download-artifact@v4).
download_run_artifacts() {
  : "${GH_TOKEN:?GH_TOKEN must be set for --from-run mode}"
  local repo="${GITHUB_REPOSITORY:-MikeBild/subkit}"
  local staging
  staging=$(mktemp -d)
  trap 'rm -rf "$staging"' RETURN

  for binary in sk tunnel-agent; do
    for combo in "${COMBOS[@]}"; do
      local os="${combo%% *}"
      local arch="${combo##* }"
      local name="${binary}_${os}_${arch}"
      local ext=""
      [ "$os" = "windows" ] && ext=".exe"
      msg "downloading $name"
      local attempt=1
      while :; do
        if gh run download "$RUN_ID" -R "$repo" -n "$name" --dir "$staging/$name" >/dev/null 2>&1; then
          break
        fi
        if [ "$attempt" -ge 5 ]; then
          err "FATAL: failed to download $name after 5 attempts"
          exit 1
        fi
        msg "retry $attempt for $name"
        sleep $((attempt * 5))
        attempt=$((attempt + 1))
      done
      # gh run download lays files inside <name>/<filename>; pluck it.
      local src
      src=$(find "$staging/$name" -type f | head -n 1)
      if [ -z "$src" ]; then
        err "FATAL: downloaded artifact $name was empty"
        exit 1
      fi
      cp "$src" "$OUT_DIR/${name}${ext}"
      chmod +x "$OUT_DIR/${name}${ext}"
    done
  done
}

# ── mode: local ─────────────────────────────────────────────────────────
#
# Smoke path. Reuses whatever the host already built via
# `bun run build:sk` / `bun run build:agent`, copied under the host's
# (linux|darwin) × (x64|arm64) name. Other combos are skipped — the
# image will still build, but /install/<absent> 404s and the install
# script falls back to GitHub.
copy_local_binaries() {
  local host_os host_arch
  case "$(uname -s)" in
    Darwin) host_os="darwin" ;;
    Linux)  host_os="linux"  ;;
    *) err "FATAL: unsupported host OS for --from-local: $(uname -s)"; exit 1 ;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) host_arch="arm64" ;;
    x86_64|amd64)  host_arch="x64"   ;;
    *) err "FATAL: unsupported host arch for --from-local: $(uname -m)"; exit 1 ;;
  esac
  for binary in sk tunnel-agent; do
    local src="$REPO_ROOT/dist/$binary"
    if [ ! -f "$src" ]; then
      err "FATAL: $src not found — run 'bun run build:${binary##tunnel-}' first"
      exit 1
    fi
    local out="$OUT_DIR/${binary}_${host_os}_${host_arch}"
    cp "$src" "$out"
    chmod +x "$out"
    msg "copied $binary → ${binary}_${host_os}_${host_arch}"
  done
}

case "$MODE" in
  run)   download_run_artifacts ;;
  local) copy_local_binaries ;;
esac

# ── SHA256SUMS ───────────────────────────────────────────────────────────
#
# Same one-liner as release.yml's publish-release job, run from inside
# OUT_DIR so paths stay relative.
msg "generating SHA256SUMS"
(
  cd "$OUT_DIR"
  : > SHA256SUMS
  # Sort for deterministic output regardless of FS enumeration order.
  # Skip SHA256SUMS itself + the committed .gitkeep placeholder.
  find . -maxdepth 1 -type f ! -name SHA256SUMS ! -name '.gitkeep' | sort | while read -r f; do
    sha256sum "$f" | sed 's|  \./|  |'
  done > SHA256SUMS
)

msg "wrote $(wc -l < "$OUT_DIR/SHA256SUMS" | tr -d ' ') entries to $OUT_DIR/SHA256SUMS"
ls -la "$OUT_DIR"
