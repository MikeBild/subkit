#!/usr/bin/env bash
set -euo pipefail

# Post-deploy canary for the production-like engine surface.
#
# Inputs (usually from .env.deploy):
#   DEPLOY_URL or ENGINE_URL
#   VERIFY_API_KEY (optional; enables authenticated checks)
#   SSH_KEY_PATH + DROPLET_HOST (+ optional DROPLET_USER) (optional; enables journal scan)
#
# Usage:
#   set -a; . ./.env.deploy; set +a
#   scripts/release/canary.sh

ENGINE_URL="${ENGINE_URL:-${DEPLOY_URL:-}}"
if [[ -z "${ENGINE_URL}" ]]; then
  echo "ENGINE_URL/DEPLOY_URL is required" >&2
  exit 2
fi
ENGINE_URL="${ENGINE_URL%/}"

echo "== health =="
curl -fsS "${ENGINE_URL}/v1/health"
echo

if [[ -x ./dist/sk ]]; then
  echo "== sk doctor =="
  ./dist/sk doctor
else
  echo "== sk doctor skipped (dist/sk missing) =="
fi

if [[ -n "${VERIFY_API_KEY:-}" ]]; then
  echo "== authenticated conversation smoke =="
  curl -fsS \
    -H "authorization: Bearer ${VERIFY_API_KEY}" \
    -H "content-type: application/json" \
    -d '{"message":"show me my knowledge sources"}' \
    "${ENGINE_URL}/v1/conversations" >/tmp/subkit-canary-conversation.json
  bun -e 'const r=JSON.parse(await Bun.file("/tmp/subkit-canary-conversation.json").text()); if (!r || typeof r !== "object") process.exit(1); console.log("conversation smoke ok")'
else
  echo "== authenticated conversation smoke skipped (VERIFY_API_KEY missing) =="
fi

if [[ -n "${SSH_KEY_PATH:-}" && -n "${DROPLET_HOST:-}" ]]; then
  echo "== remote journal scan (15m) =="
  DROPLET_USER="${DROPLET_USER:-root}"
  ssh -i "${SSH_KEY_PATH}" -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
    "${DROPLET_USER}@${DROPLET_HOST}" \
    "journalctl -u subkit-engine --since '15 minutes ago' --no-pager | grep -Ei '\"level\":\"(error|fatal)\"|oom|panic|worker_expired|dead_letter' || true"
else
  echo "== remote journal scan skipped (SSH_KEY_PATH/DROPLET_HOST missing) =="
fi
