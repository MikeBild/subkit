#!/usr/bin/env bash
#
# subkit — laptop deploy orchestrator.
#
# Runs the same stages the `.github/workflows/release.yml` pipeline
# runs, against the same host, using the same `deploy-body.sh`, so
# "push a tag" and "run this script" are interchangeable.
#
# Usage:
#   scripts/deploy.sh                         # patch bump (default)
#   scripts/deploy.sh patch|minor|major
#   scripts/deploy.sh 1.7.0                   # explicit target version
#   scripts/deploy.sh patch --dry-run         # print each step, do nothing
#   scripts/deploy.sh patch --skip-tests      # skip lint/typecheck/test gate
#   scripts/deploy.sh patch --skip-bump       # use current version, no bump
#
# Stages (each abort-on-fail):
#   1. Preflight    — clean tree, main branch, creds present, flock
#   2. Gate         — lint + typecheck + unit tests
#   3. Bump         — version.sh; local commit + local tag (not pushed)
#   4. Build        — bun build --compile --target=bun-linux-x64 → dist/engine-linux-x64
#   5. Deploy       — scp binary + Caddyfile + systemd unit; ssh runs deploy-body.sh
#   6. Verify       — verify.sh (health poll + smoke + log scan)
#   7. Publish      — git push origin main <tag>
#
# 4.2.0 systemd-native deploy. No DOCR, no `docker buildx`, no compose
# overlay. The engine is a single bun-compiled binary; postgres + caddy
# are apt-installed system services. The target host must already be
# provisioned by `scripts/do-bootstrap.sh`.
#
# Required env (or .env.deploy):
#   DEPLOY_HOST    IP/hostname of the host (DROPLET_NAME alt)
#   DEPLOY_USER    SSH user (default: root)
#   SSH_KEY_PATH    path to the private key (default: ~/.ssh/id_rsa)
#   DEPLOY_URL      base URL for smoke (default: https://subkit-api.mikebild.dev)
#   VERIFY_API_KEY  admin API key for authenticated diagnostics smoke
#                   (Stage 6). Mint on the host:
#                     ssh <host> '/usr/local/bin/engine --issue-admin-key'
#                   Or set SKIP_AUTH_DIAGNOSTICS=1 to skip the
#                   authenticated half of verify (public smoke +
#                   /v1/health + remote log scan still run).
#
# Concurrency guard: a flock on /tmp/subkit-deploy.lock prevents two
# concurrent runs from racing (local x local or local x CI).

set -euo pipefail

# ---------------------------------------------------------------------------
# Args + config
# ---------------------------------------------------------------------------

LEVEL="patch"
DRY_RUN=0
SKIP_TESTS=0
SKIP_BUMP=0

for arg in "$@"; do
  case "$arg" in
    patch|minor|major)         LEVEL="$arg" ;;
    [0-9]*.[0-9]*.[0-9]*)      LEVEL="$arg" ;;
    --dry-run)                 DRY_RUN=1 ;;
    --skip-tests)              SKIP_TESTS=1 ;;
    --skip-bump)               SKIP_BUMP=1 ;;
    -h|--help)
      sed -n '2,/^$/p' "$0" | sed 's/^#\s\?//'
      exit 0
      ;;
    *)
      echo "deploy.sh: unknown arg '$arg' (expected patch|minor|major|X.Y.Z|--dry-run|--skip-tests|--skip-bump)" >&2
      exit 2
      ;;
  esac
done

_SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$_SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

# shellcheck source=release/version.sh
source "$_SCRIPT_DIR/release/version.sh"

# Env overrides; .env.deploy is a convenient place for operator defaults.
if [ -f "$REPO_ROOT/.env.deploy" ]; then
  # shellcheck disable=SC1091
  source "$REPO_ROOT/.env.deploy"
fi

# `DROPLET_*` is the canonical naming on the GitHub-side secrets
# (matches the digitalocean-bootstrap script). The `.env.deploy` file
# typically carries `DROPLET_HOST` / `DROPLET_USER`; accept those as
# fallbacks so the laptop deploy and the CI deploy read from the same
# variable names without per-operator env-file edits.
DEPLOY_HOST="${DEPLOY_HOST:-${DROPLET_HOST:-}}"
DEPLOY_USER="${DEPLOY_USER:-${DROPLET_USER:-root}}"
DROPLET_NAME="${DROPLET_NAME:-subkit-engine}"
SSH_KEY_PATH="${SSH_KEY_PATH:-${DROPLET_SSH_KEY_PATH:-$HOME/.ssh/id_rsa}}"
DEPLOY_URL="${DEPLOY_URL:-https://subkit-api.mikebild.dev}"

# Shared ssh/scp options for every Stage 5 transfer. ConnectTimeout
# fails fast when the host is unreachable; ServerAliveInterval +
# ServerAliveCountMax tear down a stalled connection after ~60s
# (4 × 15s) instead of hanging indefinitely — without these a dead
# TCP connection with no keepalive once stalled a deploy's binary scp
# for 49 minutes before it was killed by hand.
SSH_COMMON_OPTS=(
  -i "$SSH_KEY_PATH"
  -o StrictHostKeyChecking=accept-new
  -o ConnectTimeout=15
  -o ServerAliveInterval=15
  -o ServerAliveCountMax=4
)

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

stage() { printf '\n\033[1;35m▶ %s\033[0m\n' "$*"; }
info()  { printf '\033[0;36m• %s\033[0m\n' "$*"; }
ok()    { printf '\033[1;32m✔ %s\033[0m\n' "$*"; }
fail()  { printf '\033[1;31m✘ %s\033[0m\n' "$*" >&2; }

# When --dry-run, prefix every side-effecting command.
run() {
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '  \033[1;33m[dry]\033[0m %s\n' "$*"
  else
    "$@"
  fi
}

# ---------------------------------------------------------------------------
# Concurrency guard — portable mkdir-based lock (macOS has no flock).
# mkdir is atomic across POSIX; if two concurrent runs race, only the
# first mkdir succeeds, the other fails with "File exists".
# ---------------------------------------------------------------------------

LOCK=/tmp/subkit-deploy.lock
if [ "$DRY_RUN" -eq 0 ]; then
  if ! mkdir "$LOCK" 2>/dev/null; then
    # If the lock dir is stale (owning PID dead), clean it up and retry.
    if [ -f "$LOCK/pid" ] && ! kill -0 "$(cat "$LOCK/pid" 2>/dev/null)" 2>/dev/null; then
      rm -rf "$LOCK"
      mkdir "$LOCK"
    else
      fail "another deploy is running ($LOCK held by PID $(cat "$LOCK/pid" 2>/dev/null || echo unknown)) — refusing to race"
      exit 1
    fi
  fi
  echo $$ > "$LOCK/pid"
  trap 'rm -rf "$LOCK"' EXIT INT TERM
fi

# ---------------------------------------------------------------------------
# Stage 1 — preflight
# ---------------------------------------------------------------------------
stage "preflight"

if [ "$SKIP_BUMP" -eq 0 ]; then
  # Clean tree so a bump doesn't get tangled with in-flight work.
  if [ -n "$(git status --porcelain)" ]; then
    fail "working tree is dirty — commit or stash before deploying"
    git status --short >&2
    exit 1
  fi
  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  if [ "$BRANCH" != "main" ]; then
    fail "on branch '$BRANCH' — deploy only from 'main'"
    exit 1
  fi
fi

# doctl auth — needed for build-push and the verify log tail.
if ! command -v doctl >/dev/null 2>&1; then
  fail "doctl not installed — run: brew install doctl"
  exit 1
fi
if ! doctl auth list 2>/dev/null | grep -q .; then
  fail "doctl has no auth context — run: doctl auth init --access-token <PAT>"
  exit 1
fi

# Sanity: if DEPLOY_HOST is set, ensure the SSH key exists.
if [ -n "$DEPLOY_HOST" ] && [ ! -f "$SSH_KEY_PATH" ]; then
  fail "SSH key not found at $SSH_KEY_PATH (set SSH_KEY_PATH in .env.deploy)"
  exit 1
fi

CURRENT=$(current_version)
info "repo  : $REPO_ROOT"
info "tree  : $(git log -1 --pretty=format:'%h %s')"
info "from  : $CURRENT"
info "bump  : $LEVEL"
info "host  : ${DEPLOY_HOST:-(via doctl) $DROPLET_NAME}"
info "deploy: $DEPLOY_URL"

# ---------------------------------------------------------------------------
# Stage 2 — gate
# ---------------------------------------------------------------------------
if [ "$SKIP_TESTS" -eq 0 ]; then
  stage "gate — lint + typecheck + tests"
  run bun run lint
  run bun run typecheck
  run bun test apps/ packages/
  ok "gate passed"
else
  info "skipping gate (--skip-tests)"
fi

# ---------------------------------------------------------------------------
# Stage 3 — bump version + local commit + local tag
# ---------------------------------------------------------------------------
if [ "$SKIP_BUMP" -eq 0 ]; then
  stage "bump version"
  if [ "$DRY_RUN" -eq 1 ]; then
    # Compute NEW without touching files.
    case "$LEVEL" in
      patch|minor|major)
        NEW=$(node -e "
          const [M,m,p] = '$CURRENT'.split('.').map(Number);
          const l = '$LEVEL';
          process.stdout.write(l==='major' ? (M+1)+'.0.0' : l==='minor' ? M+'.'+(m+1)+'.0' : M+'.'+m+'.'+(p+1));
        ")
        ;;
      *) NEW="$LEVEL" ;;
    esac
    info "[dry] would bump $CURRENT → $NEW"
  else
    NEW=$(bump_version "$LEVEL")
    ok "bumped $CURRENT → $NEW"
  fi
  TAG=$(tag_name "$NEW")
  run git add .release-please-manifest.json package.json
  run git commit -m "chore(release): subkit $NEW"
  run git tag -a "$TAG" -m "subkit $NEW"
else
  NEW="$CURRENT"
  TAG=$(tag_name "$NEW")
  info "skipping bump — deploying current version $NEW"
fi

# Any failure after this point should reset the local bump commit so
# `main` is not polluted with a chore commit for a failed release.
rollback_bump() {
  if [ "$SKIP_BUMP" -eq 1 ] || [ "$DRY_RUN" -eq 1 ]; then return; fi
  if [ "${PUBLISHED:-0}" -eq 1 ]; then return; fi
  fail "rolling back local bump ($TAG) so main stays clean"
  git tag -d "$TAG" >/dev/null 2>&1 || true
  git reset --hard HEAD~1 >/dev/null 2>&1 || true
}
trap rollback_bump EXIT

# ---------------------------------------------------------------------------
# Stage 4 — build engine binary for linux/x86_64
# ---------------------------------------------------------------------------
# 4.2.0: replaces the old build-push.sh DOCR pipeline. We cross-compile
# the engine to a static linux/amd64 binary right here on the laptop
# (Bun's `--target=bun-linux-x64` produces a self-contained executable
# in ~30 s; the prior docker buildx + DOCR push averaged ~3 min).
# Stage 5 ships the resulting binary to the host via scp.
stage "build engine binary"
_REPO_ROOT=$(cd "$_SCRIPT_DIR/.." && pwd)
_DIST_BIN="$_REPO_ROOT/dist/engine-linux-x64"
if [ "$DRY_RUN" -eq 1 ]; then
  info "[dry] ENGINE_VERSION=$NEW bun run build:engine:linux-x64"
else
  # Delegate to the package.json script so the cross-compile lives in
  # one place (the same script CI runs).
  ENGINE_VERSION="$NEW" run bun run build:engine:linux-x64
  if [ ! -f "$_DIST_BIN" ]; then
    fail "build did not produce $_DIST_BIN"
    exit 1
  fi
fi
ok "built dist/engine-linux-x64 (engine $NEW)"

# ---------------------------------------------------------------------------
# Stage 5 — deploy via SSH
# ---------------------------------------------------------------------------
# 4.2.0: scp the engine binary + Caddyfile + systemd unit, then run
# deploy-body.sh which atomically swaps the binary and `systemctl
# restart`s the unit. No DOCR, no docker compose. The target host must
# already be provisioned with `scripts/do-bootstrap.sh` (postgres +
# caddy + the subkit user/dirs).
stage "deploy to host"
SSH_TARGET=""
if [ -n "$DEPLOY_HOST" ]; then
  SSH_TARGET="$DEPLOY_USER@$DEPLOY_HOST"
  info "ssh target: $SSH_TARGET (key: $SSH_KEY_PATH)"
fi
_CADDYFILE="$_REPO_ROOT/deploy/caddy/Caddyfile"
_SYSTEMD_UNIT="$_REPO_ROOT/deploy/systemd/subkit-engine.service"
if [ "$DRY_RUN" -eq 1 ]; then
  info "[dry] scp $_DIST_BIN → host:/usr/local/bin/engine.next"
  info "[dry] scp $_CADDYFILE → host:/etc/caddy/Caddyfile"
  info "[dry] scp $_SYSTEMD_UNIT → host:/etc/systemd/system/subkit-engine.service"
  info "[dry] ENGINE_VERSION=$NEW ssh ... 'bash -s' < $_SCRIPT_DIR/release/deploy-body.sh"
else
  if [ -z "$SSH_TARGET" ]; then
    fail "DEPLOY_HOST is required for deploy (set in .env.deploy)"
    exit 1
  fi
  # Stream the binary up first; deploy-body.sh checks for it before
  # touching the running engine.
  scp "${SSH_COMMON_OPTS[@]}" \
    "$_DIST_BIN" \
    "$SSH_TARGET:/usr/local/bin/engine.next"
  # Caddyfile + systemd unit: re-synced every release so the repo
  # stays the source of truth. systemd `daemon-reload` runs only when
  # the unit changed; the deploy body handles that detection.
  scp "${SSH_COMMON_OPTS[@]}" \
    "$_CADDYFILE" \
    "$SSH_TARGET:/etc/caddy/Caddyfile"
  scp "${SSH_COMMON_OPTS[@]}" \
    "$_SYSTEMD_UNIT" \
    "$SSH_TARGET:/etc/systemd/system/subkit-engine.service"
  ssh "${SSH_COMMON_OPTS[@]}" \
    "$SSH_TARGET" "systemctl daemon-reload"
  # Thread bootstrap LLM config + admin API key through to deploy-body
  # so the post-health-check `PUT /v1/settings/*` step can run
  # (eat-own-dog-food: no SSH+env-edit cycle needed). All BOOTSTRAP_*
  # vars are optional; absent vars skip their PUT.
  #
  # Use ssh `SendEnv` rather than inline `FOO='value' bash -s` so the
  # secrets never appear on the laptop or host `ps -ef` output.
  # `do-bootstrap.sh` configures the matching `AcceptEnv` directives
  # in /etc/ssh/sshd_config.d/subkit.conf from the same source list
  # (deploy/bootstrap-env.list).
  export ENGINE_VERSION="$NEW"
  export VERIFY_API_KEY="${VERIFY_API_KEY:-}"
  export BOOTSTRAP_LLM_PROVIDER="${BOOTSTRAP_LLM_PROVIDER:-}"
  export BOOTSTRAP_LLM_API_KEY="${BOOTSTRAP_LLM_API_KEY:-}"
  export BOOTSTRAP_LLM_MODEL="${BOOTSTRAP_LLM_MODEL:-}"
  export BOOTSTRAP_LLM_FALLBACK_PROVIDER="${BOOTSTRAP_LLM_FALLBACK_PROVIDER:-}"
  export BOOTSTRAP_LLM_FALLBACK_MODEL="${BOOTSTRAP_LLM_FALLBACK_MODEL:-}"
  _BOOTSTRAP_ENV_LIST="$_REPO_ROOT/deploy/bootstrap-env.list"
  if [ ! -f "$_BOOTSTRAP_ENV_LIST" ]; then
    fail "deploy/bootstrap-env.list missing — required for SendEnv list"
    exit 1
  fi
  _SEND_ENV=$(grep -vE '^(\s*#|\s*$)' "$_BOOTSTRAP_ENV_LIST" | tr '\n' ' ' | sed 's/ $//')
  ssh "${SSH_COMMON_OPTS[@]}" \
    -o "SendEnv=$_SEND_ENV" \
    "$SSH_TARGET" "bash -s" \
    < "$_SCRIPT_DIR/release/deploy-body.sh"
fi
ok "host deploy returned"

# ---------------------------------------------------------------------------
# Stage 6 — verify
# ---------------------------------------------------------------------------
stage "verify"
if [ "$DRY_RUN" -eq 1 ]; then
  info "[dry] VERSION=$NEW DEPLOY_URL=$DEPLOY_URL scripts/release/verify.sh"
else
  # Forward .env.deploy values that verify.sh consumes. `source` of
  # .env.deploy at the top of this script populates shell variables
  # but doesn't export them — verify.sh runs as a subprocess, so we
  # have to thread the auth + SSH knobs through inline. Without this
  # VERIFY_API_KEY=… in .env.deploy was silently invisible to verify.sh
  # and the authenticated diagnostics step bailed every release.
  VERSION="$NEW" \
  DEPLOY_URL="$DEPLOY_URL" \
  DROPLET_NAME="$DROPLET_NAME" \
  VERIFY_API_KEY="${VERIFY_API_KEY:-}" \
  SSH_HOST="${SSH_HOST:-${DEPLOY_USER}@${DEPLOY_HOST}}" \
  SKIP_AUTH_DIAGNOSTICS="${SKIP_AUTH_DIAGNOSTICS:-0}" \
  SKIP_REMOTE_LOGS="${SKIP_REMOTE_LOGS:-0}" \
  SKIP_SETTINGS_PROBE="${SKIP_SETTINGS_PROBE:-0}" \
  BOOTSTRAP_LLM_PROVIDER="${BOOTSTRAP_LLM_PROVIDER:-}" \
    "$_SCRIPT_DIR/release/verify.sh"
fi
ok "verified"

# ---------------------------------------------------------------------------
# Stage 7 — publish (push main + tag to origin)
# ---------------------------------------------------------------------------
stage "publish"
if [ "$SKIP_BUMP" -eq 1 ]; then
  info "no local commit to publish (--skip-bump)"
else
  run git push origin main "$TAG"
fi
PUBLISHED=1
ok "subkit $NEW shipped — curl $DEPLOY_URL/v1/health"
