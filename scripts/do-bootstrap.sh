#!/usr/bin/env bash
#
# Idempotent Digital Ocean bootstrap for subkit-engine.
#
# Provisions:
#   - DO Container Registry (subkit)
#   - SSH key upload (subkit-deploy)
#   - Droplet (subkit-engine, $REGION / $SIZE, docker-20-04 image)
#   - Cloud firewall (ports 22/80/443)
#   - DNS A records for subkit-api.mikebild.dev and subkit-tunnel.mikebild.dev
#   - Copies deploy/* and docker-compose.yml to /opt/subkit/ on the droplet
#   - Installs doctl on the droplet and logs into DOCR
#   - Optionally brings up the compose stack for the first deploy
#
# Prerequisites:
#   - doctl installed locally (`brew install doctl`) and authenticated (`doctl auth init`)
#   - DO_TOKEN env var set (for droplet-side doctl auth)
#   - mikebild.dev zone already hosted on DO nameservers
#   - ~/.ssh/subkit_deploy{,.pub} exists (or SSH_KEY_PATH overrides)
#   - real-LLM env configured in /opt/subkit/.env after bootstrap

set -euo pipefail

DOCTL_VERSION="${DOCTL_VERSION:-1.108.0}"
DOMAIN_ROOT="${DOMAIN_ROOT:-mikebild.dev}"
HOST_API="${HOST_API:-subkit-api}"
HOST_TUNNEL="${HOST_TUNNEL:-subkit-tunnel}"
REGION="${REGION:-fra1}"
SIZE="${SIZE:-s-2vcpu-4gb}"
DROPLET_NAME="${DROPLET_NAME:-subkit-engine}"
REGISTRY="${REGISTRY:-subkit}"
SSH_KEY_NAME="${SSH_KEY_NAME:-subkit-deploy}"
SSH_KEY_PATH="${SSH_KEY_PATH:-$HOME/.ssh/subkit_deploy}"
FIREWALL_NAME="${FIREWALL_NAME:-subkit-engine-fw}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

say() { printf "\n\033[1;36m==>\033[0m %s\n" "$*"; }
warn() { printf "\n\033[1;33m!!\033[0m %s\n" "$*" >&2; }
die() { printf "\n\033[1;31mxx\033[0m %s\n" "$*" >&2; exit 1; }

command -v doctl >/dev/null || die "doctl not installed — run 'brew install doctl'"
doctl account get >/dev/null 2>&1 || die "doctl not authenticated — run 'doctl auth init'"
[[ -f "$SSH_KEY_PATH.pub" ]] || die "SSH public key not found at $SSH_KEY_PATH.pub"
[[ -n "${DO_TOKEN:-}" ]] || die "DO_TOKEN env var required for droplet-side doctl auth"

# --------------------------------------------------------------------------
say "1. Ensure container registry '$REGISTRY' exists"
if doctl registry get >/dev/null 2>&1; then
  existing=$(doctl registry get --format Name --no-header)
  [[ "$existing" == "$REGISTRY" ]] || die "Existing registry '$existing' differs from expected '$REGISTRY'"
  echo "   registry already exists: $existing"
else
  doctl registry create "$REGISTRY" --subscription-tier basic --region "$REGION"
fi

# --------------------------------------------------------------------------
say "2. Ensure SSH key '$SSH_KEY_NAME' is uploaded"
SSH_KEY_ID=$(doctl compute ssh-key list --format ID,Name --no-header | awk -v n="$SSH_KEY_NAME" '$2==n {print $1}')
if [[ -z "$SSH_KEY_ID" ]]; then
  SSH_KEY_ID=$(doctl compute ssh-key import "$SSH_KEY_NAME" \
    --public-key-file "$SSH_KEY_PATH.pub" \
    --format ID --no-header)
fi
echo "   ssh key id: $SSH_KEY_ID"

# --------------------------------------------------------------------------
say "3. Ensure droplet '$DROPLET_NAME' exists"
DROPLET_ID=$(doctl compute droplet list --format ID,Name --no-header | awk -v n="$DROPLET_NAME" '$2==n {print $1}')
if [[ -z "$DROPLET_ID" ]]; then
  doctl compute droplet create "$DROPLET_NAME" \
    --image docker-20-04 \
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
say "4. Ensure DNS A records on $DOMAIN_ROOT"
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
say "5. Ensure firewall '$FIREWALL_NAME' exists and attached"
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
say "6. Wait for SSH on $DROPLET_IP"
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
say "7. Seed deploy files to /opt/subkit/"
$SSH 'mkdir -p /opt/subkit /opt/subkit/caddy'
$SCP "$REPO_ROOT/docker-compose.yml" root@"$DROPLET_IP":/opt/subkit/docker-compose.yml
$SCP "$REPO_ROOT/deploy/docker-compose.prod.yml" root@"$DROPLET_IP":/opt/subkit/docker-compose.prod.yml
$SCP "$REPO_ROOT/deploy/caddy/Caddyfile" root@"$DROPLET_IP":/opt/subkit/caddy/Caddyfile

# --------------------------------------------------------------------------
say "8. Seed .env (if missing)"
if $SSH 'test -f /opt/subkit/.env'; then
  echo "   /opt/subkit/.env already present — not overwritten"
else
  $SCP "$REPO_ROOT/.env.example" root@"$DROPLET_IP":/opt/subkit/.env
  $SSH 'chmod 600 /opt/subkit/.env'
  warn "Seeded /opt/subkit/.env from template. You MUST edit it with real secrets:"
  warn "    ssh -i $SSH_KEY_PATH root@$DROPLET_IP 'vi /opt/subkit/.env'"
  warn "Required edits: MASTER_KEY, POSTGRES_PASSWORD, DATABASE_URL password, and either:"
  warn "  - AI_GATEWAY_API_KEY + AI_GATEWAY_MODEL"
  warn "  - or LLM_PROVIDER + matching provider credentials"
fi

# --------------------------------------------------------------------------
say "9. Install doctl and login to DOCR on droplet"
$SSH "command -v doctl >/dev/null || (wget -q https://github.com/digitalocean/doctl/releases/download/v${DOCTL_VERSION}/doctl-${DOCTL_VERSION}-linux-amd64.tar.gz -O /tmp/doctl.tgz && tar -C /usr/local/bin -xzf /tmp/doctl.tgz doctl)"
$SSH "doctl auth init --access-token $DO_TOKEN >/dev/null && doctl registry login --expiry-seconds 1200"

# --------------------------------------------------------------------------
say "10. Bootstrap summary"
cat <<EOF

  Droplet:    $DROPLET_NAME ($DROPLET_IP)
  DNS:        $HOST_API.$DOMAIN_ROOT  → $DROPLET_IP
              $HOST_TUNNEL.$DOMAIN_ROOT → $DROPLET_IP
  Registry:   registry.digitalocean.com/$REGISTRY/engine
  Deploy dir: /opt/subkit (on droplet)

Next steps:
  1. Edit /opt/subkit/.env on the droplet with real secrets:
       ssh -i $SSH_KEY_PATH root@$DROPLET_IP 'vi /opt/subkit/.env'
  2. Push a git tag (e.g. v0.1.0) or merge a release-please PR — the
     release workflow will build the image and deploy it.
  3. Capture the admin API key from seed logs on first deploy:
       ssh -i $SSH_KEY_PATH root@$DROPLET_IP 'cd /opt/subkit && docker compose logs seed'
  4. Smoke test:
       ./scripts/smoke.sh https://$HOST_API.$DOMAIN_ROOT "\$(jq -r .version package.json)"

GitHub Actions secrets to configure (Settings → Secrets → Actions):
  DIGITALOCEAN_ACCESS_TOKEN  = \$DO_TOKEN
  DROPLET_HOST               = $DROPLET_IP
  DROPLET_USER               = root
  DROPLET_SSH_KEY            = (contents of $SSH_KEY_PATH)
  DEPLOY_URL                 = https://$HOST_API.$DOMAIN_ROOT

EOF
