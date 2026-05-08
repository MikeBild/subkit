#!/usr/bin/env bash
#
# subkit — laptop deploy orchestrator.
#
# Runs the same stages the `.github/workflows/release.yml` pipeline
# runs, against the same droplet, using the same `deploy-body.sh`, so
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
#   4. Build+push   — build-push.sh (engine + migrate → DOCR)
#   5. Deploy       — ssh droplet 'bash -s' < deploy-body.sh
#   6. Verify       — verify.sh (health poll + smoke + log scan)
#   7. Publish      — git push origin main <tag>
#
# Required env (or .env.deploy):
#   DROPLET_HOST    IP/hostname of the droplet (DROPLET_NAME alt)
#   DROPLET_USER    SSH user (default: root)
#   SSH_KEY_PATH    path to the private key (default: ~/.ssh/id_rsa)
#   DEPLOY_URL      base URL for smoke (default: https://subkit-api.mikebild.dev)
#
# One-time operator setup:
#   doctl auth init --access-token <PAT-with-registry:update-scope>
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

DROPLET_HOST="${DROPLET_HOST:-}"
DROPLET_NAME="${DROPLET_NAME:-subkit-engine}"
DROPLET_USER="${DROPLET_USER:-root}"
SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/id_rsa}"
DEPLOY_URL="${DEPLOY_URL:-https://subkit-api.mikebild.dev}"

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

# Sanity: if DROPLET_HOST is set, ensure the SSH key exists.
if [ -n "$DROPLET_HOST" ] && [ ! -f "$SSH_KEY_PATH" ]; then
  fail "SSH key not found at $SSH_KEY_PATH (set SSH_KEY_PATH in .env.deploy)"
  exit 1
fi

CURRENT=$(current_version)
info "repo  : $REPO_ROOT"
info "tree  : $(git log -1 --pretty=format:'%h %s')"
info "from  : $CURRENT"
info "bump  : $LEVEL"
info "droplet: ${DROPLET_HOST:-(via doctl) $DROPLET_NAME}"
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
# Stage 4 — build + push engine + migrate
# ---------------------------------------------------------------------------
stage "build + push → DOCR"
if [ "$DRY_RUN" -eq 1 ]; then
  info "[dry] VERSION=$NEW scripts/release/build-push.sh"
else
  VERSION="$NEW" "$_SCRIPT_DIR/release/build-push.sh"
fi
ok "images pushed: registry.digitalocean.com/subkit/{engine,migrate}:$NEW"

# ---------------------------------------------------------------------------
# Stage 5 — deploy via SSH (executes the same file CI uses)
# ---------------------------------------------------------------------------
stage "deploy to droplet"
SSH_TARGET=""
if [ -n "$DROPLET_HOST" ]; then
  SSH_TARGET="$DROPLET_USER@$DROPLET_HOST"
  info "ssh target: $SSH_TARGET (key: $SSH_KEY_PATH)"
fi
if [ "$DRY_RUN" -eq 1 ]; then
  info "[dry] scp docker-compose.yml + deploy/docker-compose.prod.yml + deploy/caddy/Caddyfile → droplet:/opt/subkit/"
  info "[dry] ENGINE_VERSION=$NEW ssh ... 'bash -s' < $_SCRIPT_DIR/release/deploy-body.sh"
else
  # Sync droplet config before the deploy body runs. do-bootstrap.sh
  # placed these three files at provisioning time — the repo is the
  # source of truth on every release so additions or removals in the
  # base compose (e.g. PR #150 dropping the migrate service) actually
  # land on the droplet. Mirrors the equivalent step in
  # .github/workflows/release.yml so the CI and laptop paths can't drift.
  _REPO_ROOT=$(cd "$_SCRIPT_DIR/.." && pwd)
  _BASE_COMPOSE="$_REPO_ROOT/docker-compose.yml"
  _PROD_COMPOSE="$_REPO_ROOT/deploy/docker-compose.prod.yml"
  _CADDYFILE="$_REPO_ROOT/deploy/caddy/Caddyfile"
  if [ -n "$SSH_TARGET" ]; then
    scp -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=accept-new \
      "$_BASE_COMPOSE" "$_PROD_COMPOSE" \
      "$SSH_TARGET:/opt/subkit/"
    scp -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=accept-new \
      "$_CADDYFILE" \
      "$SSH_TARGET:/opt/subkit/caddy/Caddyfile"
    ssh -i "$SSH_KEY_PATH" -o StrictHostKeyChecking=accept-new \
      "$SSH_TARGET" "ENGINE_VERSION='$NEW' bash -s" \
      < "$_SCRIPT_DIR/release/deploy-body.sh"
  else
    # Fallback: use doctl compute ssh (matches what verify.sh uses).
    # doctl's ssh wrapper doesn't forward stdin cleanly for 'bash -s',
    # so we cat-pipe each file then exec the deploy body.
    doctl compute ssh "$DROPLET_NAME" --ssh-command \
      "cat > /opt/subkit/docker-compose.yml" \
      < "$_BASE_COMPOSE"
    doctl compute ssh "$DROPLET_NAME" --ssh-command \
      "cat > /opt/subkit/docker-compose.prod.yml" \
      < "$_PROD_COMPOSE"
    doctl compute ssh "$DROPLET_NAME" --ssh-command \
      "cat > /opt/subkit/caddy/Caddyfile" \
      < "$_CADDYFILE"
    TMP_REMOTE="/tmp/subkit-deploy-body.$NEW.sh"
    doctl compute ssh "$DROPLET_NAME" --ssh-command \
      "cat > $TMP_REMOTE && chmod +x $TMP_REMOTE && ENGINE_VERSION='$NEW' bash $TMP_REMOTE && rm -f $TMP_REMOTE" \
      < "$_SCRIPT_DIR/release/deploy-body.sh"
  fi
fi
ok "droplet deploy returned"

# ---------------------------------------------------------------------------
# Stage 6 — verify
# ---------------------------------------------------------------------------
stage "verify"
if [ "$DRY_RUN" -eq 1 ]; then
  info "[dry] VERSION=$NEW DEPLOY_URL=$DEPLOY_URL scripts/release/verify.sh"
else
  VERSION="$NEW" DEPLOY_URL="$DEPLOY_URL" DROPLET_NAME="$DROPLET_NAME" \
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
