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
#   - DNS A records for subkit-api.mikebild.dev and subkit-tunnel.mikebild.dev
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
# Note: no DOCR, no DO_TOKEN. The droplet doesn't pull from a registry
# anymore — releases scp the binary directly.

set -euo pipefail

DOMAIN_ROOT="${DOMAIN_ROOT:-mikebild.dev}"
HOST_API="${HOST_API:-subkit-api}"
HOST_TUNNEL="${HOST_TUNNEL:-subkit-tunnel}"
REGION="${REGION:-fra1}"
SIZE="${SIZE:-s-2vcpu-4gb}"
DROPLET_NAME="${DROPLET_NAME:-subkit-engine}"
SSH_KEY_NAME="${SSH_KEY_NAME:-subkit-deploy}"
SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/subkit_deploy}"
FIREWALL_NAME="${FIREWALL_NAME:-subkit-engine-fw}"
DROPLET_IMAGE="${DROPLET_IMAGE:-ubuntu-24-04-x64}"
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
say "2. Ensure droplet '$DROPLET_NAME' exists"
DROPLET_ID=$(doctl compute droplet list --format ID,Name --no-header | awk -v n="$DROPLET_NAME" '$2==n {print $1}')
if [[ -z "$DROPLET_ID" ]]; then
  doctl compute droplet create "$DROPLET_NAME" \
    --image "$DROPLET_IMAGE" \
    --size "$SIZE" \
    --region "$REGION" \
    --ssh-keys "$SSH_KEY_ID" \
    --tag-names subkit,engine \
    --wait
  DROPLET_ID=$(doctl compute droplet list --format ID,Name --no-header | awk -v n="$DROPLET_NAME" '$2==n {print $1}')
fi
DROPLET_IP=$(doctl compute droplet get "$DROPLET_ID" --format PublicIPv4 --no-header)
echo "   droplet id: $DROPLET_ID  ip: $DROPLET_IP"

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
ensure_a_record "$HOST_API" "$DROPLET_IP"
ensure_a_record "$HOST_TUNNEL" "$DROPLET_IP"

# --------------------------------------------------------------------------
say "4. Ensure firewall '$FIREWALL_NAME' exists and attached"
FW_ID=$(doctl compute firewall list --format ID,Name --no-header | awk -v n="$FIREWALL_NAME" '$2==n {print $1}')
if [[ -z "$FW_ID" ]]; then
  FW_ID=$(doctl compute firewall create \
    --name "$FIREWALL_NAME" \
    --inbound-rules "protocol:tcp,ports:22,address:0.0.0.0/0,address:::/0 protocol:tcp,ports:80,address:0.0.0.0/0,address:::/0 protocol:tcp,ports:443,address:0.0.0.0/0,address:::/0 protocol:udp,ports:443,address:0.0.0.0/0,address:::/0" \
    --outbound-rules "protocol:tcp,ports:all,address:0.0.0.0/0,address:::/0 protocol:udp,ports:all,address:0.0.0.0/0,address:::/0 protocol:icmp,address:0.0.0.0/0,address:::/0" \
    --droplet-ids "$DROPLET_ID" \
    --format ID --no-header)
else
  doctl compute firewall add-droplets "$FW_ID" --droplet-ids "$DROPLET_ID" >/dev/null 2>&1 || true
fi
echo "   firewall id: $FW_ID"

# --------------------------------------------------------------------------
say "5. Wait for SSH on $DROPLET_IP"
for i in $(seq 1 30); do
  if ssh -o StrictHostKeyChecking=no -o ConnectTimeout=3 -i "$SSH_KEY_PATH" root@"$DROPLET_IP" 'true' 2>/dev/null; then
    echo "   ssh ready"
    break
  fi
  [[ $i -eq 30 ]] && die "SSH never came up"
  sleep 5
done

SSH="ssh -o StrictHostKeyChecking=no -i $SSH_KEY_PATH root@$DROPLET_IP"
SCP="scp -o StrictHostKeyChecking=no -i $SSH_KEY_PATH"

# --------------------------------------------------------------------------
say "6. Install postgresql-16 + caddy on the droplet"
$SSH 'bash -s' <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# Caddy upstream key + repo (the apt-shipped caddy lags upstream and
# misses recent ACME-DNS plugins).
if [ ! -f /etc/apt/keyrings/caddy.gpg ]; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /etc/apt/keyrings/caddy.gpg
  chmod a+r /etc/apt/keyrings/caddy.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy.list
  apt-get update
fi

apt-get install -y postgresql-16 postgresql-client-16 caddy curl jq

# Postgres should listen only on 127.0.0.1 (engine + caddy share the
# host network namespace). Default config already binds localhost on
# the apt package; no edit needed unless you want to confirm.
systemctl enable --now postgresql
systemctl enable --now caddy
REMOTE
echo "   postgres + caddy installed"

# --------------------------------------------------------------------------
say "7. Create subkit system user + dirs"
$SSH 'bash -s' <<'REMOTE'
set -euo pipefail
if ! id subkit >/dev/null 2>&1; then
  useradd --system --shell /usr/sbin/nologin --home-dir /var/lib/subkit subkit
fi
install -d -o subkit -g subkit -m 0755 /var/lib/subkit /var/lib/subkit/blobs
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
# observability exporters, etc.) is settable via the sk CLI:
#   sk settings set llm.provider '"anthropic"'
#   sk settings set llm.providers.anthropic.api_key '"sk-ant-..."'
# The engine auto-creates /etc/subkit/subkit.config.json on first boot;
# sk settings set hot-reloads via pubsub.

DATABASE_URL=postgres://subkit:${PGPASS}@127.0.0.1:5432/subkit
MASTER_KEY=${MASTER_KEY}
PUBLIC_BASE_URL=https://${HOST_API}.${DOMAIN_ROOT}
EOF
  warn "Seeded /etc/subkit/.env. Mint an admin API key after first deploy:"
  warn "   ssh -i $SSH_KEY_PATH root@$DROPLET_IP '/usr/local/bin/engine --issue-admin-key'"
fi

# --------------------------------------------------------------------------
say "10. Install Caddyfile + reload caddy"
$SCP "$REPO_ROOT/deploy/caddy/Caddyfile" root@"$DROPLET_IP":/etc/caddy/Caddyfile
$SSH 'systemctl reload caddy'
echo "   /etc/caddy/Caddyfile synced"

# --------------------------------------------------------------------------
say "11. Install subkit-engine systemd unit"
$SCP "$REPO_ROOT/deploy/systemd/subkit-engine.service" root@"$DROPLET_IP":/etc/systemd/system/subkit-engine.service
$SSH 'systemctl daemon-reload && systemctl enable subkit-engine.service'
echo "   /etc/systemd/system/subkit-engine.service registered (not started — first deploy ships the binary)"

# --------------------------------------------------------------------------
say "12. Bootstrap summary"
cat <<EOF

  Droplet:    $DROPLET_NAME ($DROPLET_IP)
  DNS:        $HOST_API.$DOMAIN_ROOT  → $DROPLET_IP
              $HOST_TUNNEL.$DOMAIN_ROOT → $DROPLET_IP
  Services:   postgresql-16, caddy, subkit-engine.service (enabled)
  Engine bin: /usr/local/bin/engine (deployed by scripts/deploy.sh)
  Env file:   /etc/subkit/.env
  Config:     /etc/subkit/subkit.config.json (engine auto-creates on first boot)

Next steps:
  1. From the laptop, run: scripts/deploy.sh minor
     (builds engine binary, scp's to droplet, systemctl restart)
  2. After first successful deploy, mint an admin key:
       ssh -i $SSH_KEY_PATH root@$DROPLET_IP \\
         'sudo -u subkit /usr/local/bin/engine --issue-admin-key'
  3. Configure runtime settings via the sk CLI:
       sk login --engine-url https://$HOST_API.$DOMAIN_ROOT --api-key <key>
       sk settings set llm.provider '"anthropic"'
       sk settings set llm.providers.anthropic.api_key '"sk-ant-..."'

GitHub Actions secrets to configure (Settings → Secrets → Actions):
  DROPLET_HOST       = $DROPLET_IP
  DROPLET_USER       = root
  DROPLET_SSH_KEY    = (contents of $SSH_KEY_PATH)
  DEPLOY_URL         = https://$HOST_API.$DOMAIN_ROOT

EOF
