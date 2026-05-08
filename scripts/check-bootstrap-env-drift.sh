#!/usr/bin/env bash
#
# Bootstrap env list drift check.
#
# `deploy/bootstrap-env.list` is the canonical list of env vars passed
# from the deploy machine to the host via SSH SendEnv (one-shot per
# release). Three sites read it:
#
#   1. scripts/do-bootstrap.sh            — generates /etc/ssh/sshd_config.d/subkit.conf
#   2. scripts/deploy.sh                   — builds the SendEnv= ssh option
#   3. .github/workflows/release.yml       — same SendEnv option in CI
#
# Each consumer must reference `deploy/bootstrap-env.list` directly so
# a new variable lands in one place. This check fails if any consumer
# has drifted to a hardcoded list.
#
# Scope note: this list is the BOOTSTRAP channel (transient SSH env on
# a deploy run). It is NOT the runtime channel — at runtime the engine
# reads /etc/subkit/.env via systemd's `EnvironmentFile=` directive.
# DATABASE_URL, MASTER_KEY, PUBLIC_BASE_URL belong to the runtime
# channel and live in /etc/subkit/.env (seeded by do-bootstrap.sh
# step 9). Adding e.g. MASTER_KEY here would put the rotation key on
# the deploy machine's argv every release — exactly the wrong shape.
#
# Wired into `bun run verify` as `check:bootstrap-env-drift`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_LIST="$REPO_ROOT/deploy/bootstrap-env.list"
[[ -f "$ENV_LIST" ]] || { echo "FATAL: $ENV_LIST missing"; exit 1; }

CONSUMERS=(
  "scripts/do-bootstrap.sh"
  "scripts/deploy.sh"
  ".github/workflows/release.yml"
)

errors=0

for consumer in "${CONSUMERS[@]}"; do
  abs="$REPO_ROOT/$consumer"
  if [[ ! -f "$abs" ]]; then
    echo "FATAL: consumer $consumer missing"
    errors=$((errors + 1))
    continue
  fi
  if ! grep -qE 'deploy/bootstrap-env\.list' "$abs"; then
    echo "ERROR: $consumer does not reference deploy/bootstrap-env.list — env list drift risk"
    errors=$((errors + 1))
  fi
done

# Reverse check: every var in the list must NOT also appear as a
# hardcoded SendEnv=... or AcceptEnv ... in any consumer (would
# indicate a forgotten removal of the old hardcoded form).
while IFS= read -r var; do
  [[ -z "$var" || "$var" =~ ^[[:space:]]*# ]] && continue
  for consumer in "${CONSUMERS[@]}"; do
    abs="$REPO_ROOT/$consumer"
    [[ -f "$abs" ]] || continue
    # `\b` doesn't fire between two word chars (letter/digit/_), so
    # `\bUSER\b` does NOT match `USERNAME` (the `R↔N` boundary is
    # internal to a single word). But `\bUSER\b` WOULD match
    # `USER FOO` and `USER,FOO` (the `R↔space` and `R↔,` boundaries
    # are word-vs-non-word). We anchor explicitly with the SendEnv
    # delimiter set ({space, =, ", $}) to drop any ambiguity for
    # future variables whose names contain regex metachars.
    if grep -qE "SendEnv=[^\"]*\\b${var}([[:space:]\"=,]|$)" "$abs"; then
      echo "ERROR: $consumer hardcodes $var in a SendEnv= line — must read from deploy/bootstrap-env.list instead"
      errors=$((errors + 1))
    fi
  done
done < "$ENV_LIST"

if [[ $errors -gt 0 ]]; then
  echo "bootstrap-env drift check: $errors error(s)"
  exit 1
fi

count=$(grep -cvE '^(\s*#|\s*$)' "$ENV_LIST")
echo "bootstrap-env drift check: OK ($count vars, ${#CONSUMERS[@]} consumers)"
