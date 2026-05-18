#!/usr/bin/env bash
#
# Idempotent Digital Ocean bootstrap for subkit-engine.
#
# 4.2.0 systemd-native provisioning. Replaces the docker-compose model
# with apt-installed services + a single bun-compiled binary:
#   - postgresql-16   (apt, native systemd unit)
#   - caddy           (apt, native systemd unit)
#   - subkit-engine   (custom systemd unit at /etc/systemd/system/)
#
# Provisions:
#   - SSH key upload (subkit-deploy) on Digital Ocean
#   - Droplet (subkit-engine, $REGION / $SIZE, ubuntu-24-04 image)
#   - Cloud firewall (ports 22/80/443)
#   - DNS A record for subkit-api.mikebild.dev
#   - subkit system user/group + /etc/subkit + /var/lib/subkit + /var/log/subkit
#   - postgres role + database (subkit:<password>) listening on 127.0.0.1
#   - caddy with the repo's Caddyfile
#   - subkit-engine.service systemd unit (enabled, NOT started — first
#     deploy ships the binary)
#
# Prerequisites:
#   - doctl installed locally (`brew install doctl`) and authenticated
#   - mikebild.dev zone on DO nameservers
#   - ~/.ssh/subkit_deploy{,.pub} exists (or SSH_KEY_PATH overrides)
#
# Note: no DOCR, no DO_TOKEN. The host does not pull from a registry
# anymore — releases scp the binary directly.

set -euo pipefail

DOMAIN_ROOT="${DOMAIN_ROOT:-mikebild.dev}"
HOST_API="${HOST_API:-subkit-api}"
REGION="${REGION:-fra1}"
SIZE="${SIZE:-s-2vcpu-4gb}"
HOST_NAME="${DROPLET_NAME:-subkit-engine}"
SSH_KEY_NAME="${SSH_KEY_NAME:-subkit-deploy}"
SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/subkit_deploy}"
FIREWALL_NAME="${FIREWALL_NAME:-subkit-engine-fw}"
HOST_OS_IMAGE="${DROPLET_IMAGE:-ubuntu-24-04-x64}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

say() { printf "\n\033[1;36m==>\033[0m %s\n" "$*"; }
warn() { printf "\n\033[1;33m!!\033[0m %s\n" "$*" >&2; }
die() { printf "\n\033[1;31mxx\033[0m %s\n" "$*" >&2; exit 1; }

command -v doctl >/dev/null || die "doctl not installed — run 'brew install doctl'"
doctl account get >/dev/null 2>&1 || die "doctl not authenticated — run 'doctl auth init'"
[[ -f "$SSH_KEY_PATH.pub" ]] || die "SSH public key not found at $SSH_KEY_PATH.pub"

# --------------------------------------------------------------------------
say "1. Ensure SSH key '$SSH_KEY_NAME' is uploaded"
SSH_KEY_ID=$(doctl compute ssh-key list --format ID,Name --no-header | awk -v n="$SSH_KEY_NAME" '$2==n {print $1}')
if [[ -z "$SSH_KEY_ID" ]]; then
  SSH_KEY_ID=$(doctl compute ssh-key import "$SSH_KEY_NAME" \
    --public-key-file "$SSH_KEY_PATH.pub" \
    --format ID --no-header)
fi
echo "   ssh key id: $SSH_KEY_ID"

# --------------------------------------------------------------------------
say "2. Ensure host '$HOST_NAME' exists"
# `doctl compute droplet *` is the literal DigitalOcean upstream API
# (Droplet is DO's product name for a VM). Operator-facing vocabulary
# elsewhere uses "host"; these lines stay as the API resource name.
HOST_ID=$(doctl compute droplet list --format ID,Name --no-header | awk -v n="$HOST_NAME" '$2==n {print $1}')
if [[ -z "$HOST_ID" ]]; then
  doctl compute droplet create "$HOST_NAME" \
    --image "$HOST_OS_IMAGE" \
    --size "$SIZE" \
    --region "$REGION" \
    --ssh-keys "$SSH_KEY_ID" \
    --tag-names subkit,engine \
    --wait
  HOST_ID=$(doctl compute droplet list --format ID,Name --no-header | awk -v n="$HOST_NAME" '$2==n {print $1}')
fi
HOST_IP=$(doctl compute droplet get "$HOST_ID" --format PublicIPv4 --no-header)
echo "   host id: $HOST_ID  ip: $HOST_IP"

# --------------------------------------------------------------------------
say "3. Ensure DNS A records on $DOMAIN_ROOT"
doctl compute domain get "$DOMAIN_ROOT" >/dev/null 2>&1 \
  || die "Zone '$DOMAIN_ROOT' not on DO. Add it with: doctl compute domain create $DOMAIN_ROOT"

ensure_a_record() {
  local name="$1" ip="$2"
  local existing
  existing=$(doctl compute domain records list "$DOMAIN_ROOT" \
    --format ID,Type,Name,Data --no-header \
    | awk -v n="$name" '$2=="A" && $3==n {print $1, $4}')
  if [[ -z "$existing" ]]; then
    doctl compute domain records create "$DOMAIN_ROOT" \
      --record-type A --record-name "$name" --record-data "$ip" --record-ttl 300 >/dev/null
    echo "   created A $name.$DOMAIN_ROOT → $ip"
  else
    local rec_id rec_ip
    rec_id=$(echo "$existing" | awk '{print $1}')
    rec_ip=$(echo "$existing" | awk '{print $2}')
    if [[ "$rec_ip" != "$ip" ]]; then
      doctl compute domain records update "$DOMAIN_ROOT" \
        --record-id "$rec_id" --record-data "$ip" >/dev/null
      echo "   updated A $name.$DOMAIN_ROOT → $ip (was $rec_ip)"
    else
      echo "   A $name.$DOMAIN_ROOT already points to $ip"
    fi
  fi
}
ensure_a_record "$HOST_API" "$HOST_IP"

# --------------------------------------------------------------------------
say "4. Ensure firewall '$FIREWALL_NAME' exists and attached"
FW_ID=$(doctl compute firewall list --format ID,Name --no-header | awk -v n="$FIREWALL_NAME" '$2==n {print $1}')
if [[ -z "$FW_ID" ]]; then
  FW_ID=$(doctl compute firewall create \
    --name "$FIREWALL_NAME" \
    --inbound-rules "protocol:tcp,ports:22,address:0.0.0.0/0,address:::/0 protocol:tcp,ports:80,address:0.0.0.0/0,address:::/0 protocol:tcp,ports:443,address:0.0.0.0/0,address:::/0 protocol:udp,ports:443,address:0.0.0.0/0,address:::/0" \
    --outbound-rules "protocol:tcp,ports:all,address:0.0.0.0/0,address:::/0 protocol:udp,ports:all,address:0.0.0.0/0,address:::/0 protocol:icmp,address:0.0.0.0/0,address:::/0" \
    --droplet-ids "$HOST_ID" \
    --format ID --no-header)
else
  doctl compute firewall add-droplets "$FW_ID" --droplet-ids "$HOST_ID" >/dev/null 2>&1 || true
fi
echo "   firewall id: $FW_ID"

# --------------------------------------------------------------------------
say "5. Wait for SSH on $HOST_IP"
for i in $(seq 1 30); do
  if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=3 -i "$SSH_KEY_PATH" root@"$HOST_IP" 'true' 2>/dev/null; then
    echo "   ssh ready"
    break
  fi
  [[ $i -eq 30 ]] && die "SSH never came up"
  sleep 5
done

SSH="ssh -o StrictHostKeyChecking=no -i $SSH_KEY_PATH root@$HOST_IP"
SCP="scp -o StrictHostKeyChecking=no -i $SSH_KEY_PATH"

# --------------------------------------------------------------------------
say "5b. Pre-flight: host must not be a pre-4.2.0 docker installation"
# Re-running this script on a host bootstrapped before 4.2.0 (image:
# docker-20-04, /opt/subkit/docker-compose.yml present) silently apt-
# installs postgresql alongside the live compose stack. Fail fast
# instead of producing a dpkg-conflict mess.
if $SSH 'test -f /opt/subkit/docker-compose.yml'; then
  die "Pre-4.2.0 docker host detected at /opt/subkit/docker-compose.yml. Create a fresh ubuntu-24-04 host (HOST_NAME=<new-name> $0) and migrate the data via pg_dump. Aborting before apt-installs collide with the running compose stack."
fi

# --------------------------------------------------------------------------
say "6. Install postgresql-16 + caddy on the host"
$SSH 'bash -s' <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Caddy upstream key + repo (the apt-shipped caddy lags upstream and
# misses recent ACME-DNS plugins).
#
# The cloudsmith-served `debian.deb.txt` references the keyring at
# /usr/share/keyrings/caddy-stable-archive-keyring.gpg (signed-by= in
# the .list). We must dearmor to that exact path or apt-update fails
# with NO_PUBKEY ABA1F9B8875A6661.
if [ ! -f /usr/share/keyrings/caddy-stable-archive-keyring.gpg ]; then
  install -m 0755 -d /usr/share/keyrings
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  chmod a+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy.list
  apt-get update
fi

apt-get install -y postgresql-16 postgresql-client-16 caddy curl jq

# Hard assertion: deploy-body.sh's read_running_version() pipes
# /v1/health into `jq -r '.version // empty'`. A missing jq means
# every deploy hangs on the 150 s health timeout. Fail bootstrap
# instead so the operator notices the gap immediately.
command -v jq >/dev/null || { echo "FATAL: jq did not install"; exit 1; }
command -v curl >/dev/null || { echo "FATAL: curl did not install"; exit 1; }

# Postgres should listen only on 127.0.0.1 (engine + caddy share the
# host network namespace). Default config already binds localhost on
# the apt package; no edit needed unless you want to confirm.
systemctl enable --now postgresql
systemctl enable --now caddy

install -d -m 0755 /etc/ssh/sshd_config.d
REMOTE
echo "   postgres + caddy installed"

# --------------------------------------------------------------------------
say "6b. Configure sshd AcceptEnv from deploy/bootstrap-env.list"
# Single source of truth: deploy/bootstrap-env.list. Build the AcceptEnv
# block locally so the heredoc above doesn't have to mirror the list.
# scripts/deploy.sh and .github/workflows/release.yml read the same
# file for their SendEnv= option, so a new bootstrap variable lands
# in one place. One `AcceptEnv` per variable — globbing them into one
# line risks sshd silently rejecting the config when the line gets
# long.
ENV_LIST="$REPO_ROOT/deploy/bootstrap-env.list"
[[ -f "$ENV_LIST" ]] || die "deploy/bootstrap-env.list missing — required for sshd AcceptEnv config"
TMP_SSHD=$(mktemp)
{
  echo "# Subkit deploy: accept bootstrap env vars sent via 'ssh -o SendEnv=…'"
  echo "# from scripts/deploy.sh and .github/workflows/release.yml."
  echo "# Generated by scripts/do-bootstrap.sh from deploy/bootstrap-env.list."
  echo "# Each var on its own line so a long line doesn't get silently dropped."
  grep -vE '^(\s*#|\s*$)' "$ENV_LIST" | while IFS= read -r var; do
    [[ -n "$var" ]] && echo "AcceptEnv $var"
  done
} > "$TMP_SSHD"
$SCP "$TMP_SSHD" root@"$HOST_IP":/etc/ssh/sshd_config.d/subkit.conf
$SSH 'chmod 0644 /etc/ssh/sshd_config.d/subkit.conf && systemctl reload ssh'
rm -f "$TMP_SSHD"
echo "   sshd AcceptEnv configured ($(grep -cvE '^(\s*#|\s*$)' "$ENV_LIST") vars)"

# --------------------------------------------------------------------------
say "7. Create subkit system user + dirs"
$SSH 'bash -s' <<'REMOTE'
set -euo pipefail
if ! id subkit >/dev/null 2>&1; then
  useradd --system --shell /usr/sbin/nologin --home-dir /var/lib/subkit subkit
fi
install -d -o subkit -g subkit -m 0755 /var/lib/subkit /var/lib/subkit/blobs
# Local file-storage root (storage.files.dir). 0700 because files
# include tenant-uploaded content (chat attachments, knowledge
# sources, workflow inputs/outputs, discovery archives) — keep
# them invisible to other unix users on the host. The systemd unit
# seeds SK_OVERRIDE_STORAGE_FILES_DIR=/var/lib/subkit/files so
# the engine reads from here instead of the ephemeral /tmp fallback.
install -d -o subkit -g subkit -m 0700 /var/lib/subkit/files
install -d -o subkit -g subkit -m 0750 /etc/subkit /var/log/subkit
REMOTE

# --------------------------------------------------------------------------
say "8. Provision postgres role + database (idempotent)"
PGPASS_REMOTE=$($SSH 'test -f /etc/subkit/.pgpass && cat /etc/subkit/.pgpass || true' || echo "")
if [ -z "$PGPASS_REMOTE" ]; then
  PGPASS=$(openssl rand -hex 24)
  $SSH "echo -n '$PGPASS' > /etc/subkit/.pgpass && chown subkit:subkit /etc/subkit/.pgpass && chmod 600 /etc/subkit/.pgpass"
else
  PGPASS="$PGPASS_REMOTE"
  echo "   reusing existing /etc/subkit/.pgpass"
fi
$SSH "sudo -u postgres psql -tc \"SELECT 1 FROM pg_roles WHERE rolname='subkit'\" | grep -q 1 \
  || sudo -u postgres psql -c \"CREATE ROLE subkit LOGIN PASSWORD '$PGPASS'\""
$SSH "sudo -u postgres psql -tc \"SELECT 1 FROM pg_database WHERE datname='subkit'\" | grep -q 1 \
  || sudo -u postgres createdb -O subkit subkit"
echo "   postgres role 'subkit' + database 'subkit' present"

# --------------------------------------------------------------------------
say "9. Seed /etc/subkit/.env (operator-edited bootstrap config)"
if $SSH 'test -f /etc/subkit/.env'; then
  echo "   /etc/subkit/.env already present — not overwritten"
else
  MASTER_KEY=$(openssl rand -hex 32)
  cat <<EOF | $SSH 'cat > /etc/subkit/.env && chown subkit:subkit /etc/subkit/.env && chmod 600 /etc/subkit/.env'
# Bootstrap-only env. EVERY non-bootstrap setting (LLM provider, model,
# observability exporters, server.public_base_url, etc.) is settable via
# the sk CLI:
#   sk settings set llm.provider '"anthropic"'
#   sk settings set llm.providers.anthropic.api_key '"sk-ant-..."'
#   sk settings set server.public_base_url '"https://api.example.dev"'
# The engine auto-creates /etc/subkit/subkit.config.json on first boot;
# sk settings set hot-reloads via pubsub.

DATABASE_URL=postgres://subkit:${PGPASS}@127.0.0.1:5432/subkit
MASTER_KEY=${MASTER_KEY}
EOF
  # PUBLIC_BASE_URL was retired in 4.2.0 (see RETIRED_ENV_KEYS in
  # apps/engine/src/env.ts). Shipping it here would make every fresh
  # bootstrap raise the `public-base-url` warning in
  # /v1/diagnostics/setup the first time the operator opens sk
  # (the diagnostic only reads getConfig(), which doesn't see env).
  # The tenant-write seeding below now PUTs server.public_base_url
  # via the engine API, the same path `sk settings set` uses.
  warn "Seeded /etc/subkit/.env. Mint an admin API key after first deploy:"
  warn "   ssh -i $SSH_KEY_PATH root@$HOST_IP \\"
  warn "     \"sudo -u subkit -H bash -c 'set -a; . /etc/subkit/.env; set +a; cd /etc/subkit && /usr/local/bin/engine --issue-admin-key'\""
  warn "   (the -H + sourced .env + cd are required so the CLI finds DATABASE_URL/MASTER_KEY"
  warn "    and persists subkit.config.json under /etc/subkit, not /root.)"
  warn "Then publish the public base URL via:"
  warn "   sk settings set server.public_base_url '\"https://${HOST_API}.${DOMAIN_ROOT}\"'"
  warn "   (the diagnostic reads getConfig(), not env — setting it via sk audits the change."
  warn "    Substitute with a real domain if HOST_API/DOMAIN_ROOT differ from your DNS.)"
fi

# --------------------------------------------------------------------------
say "10. Install Caddyfile + reload caddy"
$SCP "$REPO_ROOT/deploy/caddy/Caddyfile" root@"$HOST_IP":/etc/caddy/Caddyfile
$SSH 'systemctl reload caddy'
echo "   /etc/caddy/Caddyfile synced"

# --------------------------------------------------------------------------
say "11. Install subkit-engine systemd unit"
$SCP "$REPO_ROOT/deploy/systemd/subkit-engine.service" root@"$HOST_IP":/etc/systemd/system/subkit-engine.service
$SSH 'systemctl daemon-reload && systemctl enable subkit-engine.service'
echo "   /etc/systemd/system/subkit-engine.service registered (not started — first deploy ships the binary)"

# --------------------------------------------------------------------------
say "12. Bootstrap summary"
cat <<EOF

  Droplet:    $HOST_NAME ($HOST_IP)
  DNS:        $HOST_API.$DOMAIN_ROOT  → $HOST_IP
  Services:   postgresql-16, caddy, subkit-engine.service (enabled)
  Engine bin: /usr/local/bin/engine (deployed by scripts/deploy.sh)
  Env file:   /etc/subkit/.env
  Config:     /etc/subkit/subkit.config.json (engine auto-creates on first boot)

Next steps:
  1. From the laptop, run: scripts/deploy.sh minor
     (builds engine binary, scp's to host, systemctl restart)
  2. After first successful deploy, mint an admin key:
       ssh -i $SSH_KEY_PATH root@$HOST_IP \\
         "sudo -u subkit -H bash -c 'set -a; . /etc/subkit/.env; set +a; cd /etc/subkit && /usr/local/bin/engine --issue-admin-key'"
  3. Configure runtime settings via the sk CLI:
       sk login --engine-url https://$HOST_API.$DOMAIN_ROOT --api-key <key>
       sk settings set llm.provider '"anthropic"'
       sk settings set llm.providers.anthropic.api_key '"sk-ant-..."'

GitHub Actions secrets to configure (Settings → Secrets → Actions):
  DEPLOY_HOST       = $HOST_IP
  DEPLOY_USER       = root
  DEPLOY_SSH_KEY    = (contents of $SSH_KEY_PATH)
  DEPLOY_URL         = https://$HOST_API.$DOMAIN_ROOT

EOF
