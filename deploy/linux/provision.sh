#!/usr/bin/env bash
# TripleUCrypt host provisioning. ASCII-only and idempotent: safe to re-run.
#
# Design notes:
#  * No inbound port except SSH. The app is reached ONLY through Cloudflare
#    Tunnel, which dials outbound, so :8200 is never published to the internet.
#  * The GitHub deploy key is generated ON THIS BOX. Its private half never
#    passes through droplet metadata, a chat log, or a clipboard; only the
#    public half leaves, registered read-only on the repo.
#  * Swap is added because a 2 GB box running "vite build" can otherwise OOM.
#  * Builds from source rather than pulling ghcr.io (that image is private, and
#    building here avoids putting a registry credential on the box).
set -euo pipefail

APP_DIR=/opt/tripleucrypt
REPO_SSH="git@github.com:TripleU613/TripleUCrypt.git"

log() { echo "== $*"; }

log "base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg git ufw unattended-upgrades jq >/dev/null

log "swap (build headroom)"
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile >/dev/null
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
  sysctl -q -w vm.swappiness=10
fi

log "docker ce"
if ! command -v docker >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  ARCH=$(dpkg --print-architecture)
  CODENAME=$(. /etc/os-release && echo "$VERSION_CODENAME")
  echo "deb [arch=$ARCH signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $CODENAME stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true

log "docker daemon log caps"
if [ ! -f /etc/docker/daemon.json ]; then
  mkdir -p /etc/docker
  cat > /etc/docker/daemon.json <<'JSON'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "3" }
}
JSON
  systemctl restart docker
fi

log "firewall (ssh only; tunnel is outbound)"
ufw --force reset >/dev/null 2>&1 || true
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null
ufw --force enable >/dev/null

log "ssh hardening (keys only)"
cat > /etc/ssh/sshd_config.d/99-tuc.conf <<'CONF'
PasswordAuthentication no
PermitRootLogin prohibit-password
KbdInteractiveAuthentication no
CONF
systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true

log "unattended security upgrades"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

log "repo deploy key (private half stays on this box)"
mkdir -p /root/.ssh && chmod 700 /root/.ssh
if [ ! -f /root/.ssh/tuc_deploy ]; then
  ssh-keygen -t ed25519 -f /root/.ssh/tuc_deploy -N "" -C "tripleucrypt-tor1-deploy" -q
fi
chmod 600 /root/.ssh/tuc_deploy
touch /root/.ssh/known_hosts
grep -q '^github.com' /root/.ssh/known_hosts 2>/dev/null || \
  ssh-keyscan -t ed25519 github.com >> /root/.ssh/known_hosts 2>/dev/null || true

mkdir -p "$APP_DIR/src"

log "compose stack"
cat > "$APP_DIR/docker-compose.yml" <<'YAML'
services:
  app:
    build:
      context: /opt/tripleucrypt/src
      dockerfile: Dockerfile
    image: tripleucrypt:local
    container_name: tripleucrypt
    restart: unless-stopped
    environment:
      # Must match the named volume below: where the paper ledger, settings,
      # window history and any generated wallet key persist.
      - TC_DATA_DIR=/app/data
    env_file:
      - path: /opt/tripleucrypt/secrets.env
        required: false
    volumes:
      # Named volume, NOT a bind mount: docker seeds it with the image's
      # ownership so the non-root "tripleu" user in the container can write.
      # A root-owned host bind mount could not.
      - tuc_data:/app/data
    expose:
      - "8200"
    healthcheck:
      test: ["CMD", "curl", "-fsS", "http://localhost:8200/health"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 40s

  cloudflared:
    image: cloudflare/cloudflared:2024.10.0
    container_name: tripleucrypt-tunnel
    restart: unless-stopped
    command: tunnel --no-autoupdate run
    env_file:
      - path: /opt/tripleucrypt/tunnel.env
        required: true
    depends_on:
      app:
        condition: service_healthy
    profiles: ["tunnel"]

volumes:
  tuc_data:
    driver: local
YAML

log "secrets template (practice mode by default)"
if [ ! -f "$APP_DIR/secrets.env" ]; then
  cat > "$APP_DIR/secrets.env" <<'ENVF'
# Live-trading credentials. EMPTY = practice (paper) mode, the safe default.
#
# Add them with:  tuc-secrets
# Never paste a wallet private key into a chat, a ticket, or shell history.
#
# POLY_PRIVATE_KEY=0x...
# POLY_WALLET_ADDRESS=0x...
# POLYGONSCAN_API_KEY=...
#
# On-chain write paths are default-OFF; they unlock via the in-app
# "Enable trading" confirm, or by setting these:
# TUC_EOA_APPROVE_ENABLED=1
# TUC_REDEEM_ENABLED=1
# TUC_SWAP_ENABLED=1
ENVF
  chmod 600 "$APP_DIR/secrets.env"
fi

log "helper commands"
cat > /usr/local/bin/tuc-deploy <<'SH'
#!/usr/bin/env bash
# Clone-or-pull, rebuild, bring the stack up, wait for health.
set -euo pipefail
SRC=/opt/tripleucrypt/src
export GIT_SSH_COMMAND="ssh -i /root/.ssh/tuc_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
if [ -d "$SRC/.git" ]; then
  echo "==> pull"
  git -C "$SRC" fetch --depth 1 origin main
  git -C "$SRC" reset --hard origin/main
else
  echo "==> clone"
  rm -rf "$SRC"; mkdir -p "$SRC"
  git clone --depth 1 -b main git@github.com:TripleU613/TripleUCrypt.git "$SRC"
fi
echo "==> $(git -C "$SRC" rev-parse --short HEAD) $(git -C "$SRC" log -1 --format=%s)"
cd /opt/tripleucrypt
PROFILES=()
if [ -s tunnel.env ] && grep -q '^TUNNEL_TOKEN=.\+' tunnel.env; then
  PROFILES=(--profile tunnel); echo "==> tunnel token present"
else
  echo "==> no tunnel token yet, app only (use tuc-tunnel to add one)"
fi
docker compose "${PROFILES[@]}" up -d --build
echo "==> waiting for health"
for i in $(seq 1 30); do
  s=$(docker inspect -f '{{.State.Health.Status}}' tripleucrypt 2>/dev/null || echo starting)
  if [ "$s" = healthy ]; then echo "healthy"; docker compose ps; exit 0; fi
  sleep 10
done
echo "!! not healthy within 300s" >&2
docker compose logs --tail 60 app >&2
exit 1
SH

cat > /usr/local/bin/tuc-tunnel <<'SH'
#!/usr/bin/env bash
# Provision the Cloudflare Tunnel token, then start cloudflared.
set -euo pipefail
if [ -n "${1:-}" ]; then TOKEN="$1"; else read -rsp "Cloudflare Tunnel token: " TOKEN; echo; fi
[ -n "$TOKEN" ] || { echo "empty token" >&2; exit 1; }
umask 077
printf 'TUNNEL_TOKEN=%s\n' "$TOKEN" > /opt/tripleucrypt/tunnel.env
chmod 600 /opt/tripleucrypt/tunnel.env
cd /opt/tripleucrypt
docker compose --profile tunnel up -d
echo "cloudflared started. logs: tuc-logs"
SH

cat > /usr/local/bin/tuc-secrets <<'SH'
#!/usr/bin/env bash
# Edit live-trading credentials on the box, then restart.
# Interactive on purpose: a wallet key should never land in a transcript or history.
set -euo pipefail
${EDITOR:-nano} /opt/tripleucrypt/secrets.env
chmod 600 /opt/tripleucrypt/secrets.env
cd /opt/tripleucrypt && docker compose up -d
echo "restarted with updated secrets."
SH

cat > /usr/local/bin/tuc-logs <<'SH'
#!/usr/bin/env bash
cd /opt/tripleucrypt && exec docker compose logs -f --tail "${1:-100}"
SH

cat > /usr/local/bin/tuc-status <<'SH'
#!/usr/bin/env bash
cd /opt/tripleucrypt
echo "=== containers ==="; docker compose ps
echo; echo "=== health ==="
docker exec tripleucrypt curl -fsS http://localhost:8200/health 2>/dev/null | jq . || echo "(unreachable)"
echo; echo "=== source ==="
git -C /opt/tripleucrypt/src log -1 --format='%h %s (%ci)' 2>/dev/null || echo "(not cloned)"
echo; echo "=== resources ==="; free -h | head -2; df -h / | tail -1
SH

cat > /usr/local/bin/tuc-boot <<'SH'
#!/usr/bin/env bash
# Boot-time bring-up: no rebuild and no network fetch, so a GitHub or registry
# outage can never stop the box from coming back up.
set -euo pipefail
cd /opt/tripleucrypt
[ -d src/.git ] || { echo "source not cloned yet; skipping"; exit 0; }
PROFILES=()
if [ -s tunnel.env ] && grep -q '^TUNNEL_TOKEN=.\+' tunnel.env; then PROFILES=(--profile tunnel); fi
exec docker compose "${PROFILES[@]}" up -d
SH

chmod 0755 /usr/local/bin/tuc-deploy /usr/local/bin/tuc-tunnel /usr/local/bin/tuc-secrets \
           /usr/local/bin/tuc-logs /usr/local/bin/tuc-status /usr/local/bin/tuc-boot

log "systemd unit"
cat > /etc/systemd/system/tripleucrypt.service <<'UNIT'
[Unit]
Description=TripleUCrypt trading terminal (docker compose)
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/tripleucrypt
ExecStart=/usr/local/bin/tuc-boot
ExecStop=/usr/bin/docker compose down
TimeoutStartSec=600

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable tripleucrypt.service >/dev/null 2>&1

log "provisioning complete"
echo
echo "deploy public key (register read-only on the repo):"
cat /root/.ssh/tuc_deploy.pub
