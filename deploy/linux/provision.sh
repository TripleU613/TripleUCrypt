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

# A freshly-booted cloud image runs its own apt (cloud-init / unattended-upgrades)
# for the first minute or two. Racing it dies with "Could not get lock", so wait
# for the locks to clear instead of exploding on a brand-new box.
wait_for_apt() {
  local waited=0
  while fuser /var/lib/dpkg/lock-frontend /var/lib/apt/lists/lock \
              /var/lib/dpkg/lock >/dev/null 2>&1; do
    [ "$waited" -ge 300 ] && { echo "!! apt still locked after 300s" >&2; return 1; }
    [ "$waited" = 0 ] && echo "   waiting for boot-time apt to finish..."
    sleep 5; waited=$((waited + 5))
  done
  return 0
}

log "base packages"
export DEBIAN_FRONTEND=noninteractive
wait_for_apt
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
  wait_for_apt
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
ufw limit 22/tcp comment 'ssh rate-limited' >/dev/null
ufw --force enable >/dev/null

log "ssh hardening (keys only)"
cat > /etc/ssh/sshd_config.d/99-tuc.conf <<'CONF'
PasswordAuthentication no
PermitRootLogin prohibit-password
KbdInteractiveAuthentication no
MaxAuthTries 3
LoginGraceTime 20
AllowTcpForwarding no
X11Forwarding no
CONF
sshd -t && { systemctl restart ssh 2>/dev/null || systemctl restart sshd 2>/dev/null || true; }

log "fail2ban (port 22 is reachable from the internet, so ban brute-forcers)"
wait_for_apt
apt-get install -y -qq fail2ban >/dev/null
cat > /etc/fail2ban/jail.d/sshd.local <<'CONF'
[sshd]
enabled  = true
backend  = systemd
mode     = aggressive
maxretry = 4
findtime = 10m
bantime  = 24h
# Escalate repeat offenders: each re-offence multiplies the ban.
bantime.increment = true
bantime.factor    = 4
bantime.maxtime   = 30d
CONF
systemctl enable --now fail2ban >/dev/null 2>&1 || true

log "unattended security upgrades"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
CONF
systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

log "repo deploy key (private half stays on this box)"
mkdir -p /root/.ssh && chmod 700 /root/.ssh
if [ ! -f /root/.ssh/tuc_deploy ]; then
  ssh-keygen -t ed25519 -f /root/.ssh/tuc_deploy -N "" -C "tripleucrypt-$(hostname)-deploy" -q
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
    ports:
      # Loopback ONLY -- not reachable from the internet (ufw denies inbound too).
      # cloudflared reaches it at localhost:8200 via network_mode: host below,
      # which matches the ingress the retired native install used, so moving
      # hosts needs no Cloudflare-side reconfiguration.
      - "127.0.0.1:8200:8200"
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
    network_mode: host
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
# Pull the image GitHub already built (docker.yml -> GHCR) and restart. Falls back
# to a local source build only if the prebuilt image can't be pulled.
#
# WHY: docker.yml builds and publishes the image on every push using GitHub's fast
# runners. Rebuilding the SAME image here on a 2-core box was a ~10 min duplicate of
# work already done in ~2 min upstream. Pulling makes a deploy ~30s.
set -euo pipefail
SRC=/opt/tripleucrypt/src
IMG=ghcr.io/tripleu613/tripleucrypt
export GIT_SSH_COMMAND="ssh -i /root/.ssh/tuc_deploy -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new"
if [ -d "$SRC/.git" ]; then
  echo "==> pull source"
  git -C "$SRC" fetch --depth 1 origin main
  git -C "$SRC" reset --hard origin/main
else
  echo "==> clone source"
  rm -rf "$SRC"; mkdir -p "$SRC"
  git clone --depth 1 -b main git@github.com:TripleU613/TripleUCrypt.git "$SRC"
fi
SHA=$(git -C "$SRC" rev-parse --short HEAD)
echo "==> $SHA $(git -C "$SRC" log -1 --format=%s)"
cd /opt/tripleucrypt

# ── Prefer the prebuilt image for THIS commit ─────────────────────────────────
# docker.yml tags with the short SHA. It runs in PARALLEL with this deploy, so poll
# briefly for the tag. Distinguish "not published yet" (retry) from "unauthorized"
# (package is private / no creds -> give up now and build, don't waste minutes).
prebuilt=0
for i in $(seq 1 12); do
  err=$(docker pull "$IMG:$SHA" 2>&1) && { prebuilt=1; break; }
  if echo "$err" | grep -qiE 'unauthorized|denied|forbidden'; then
    echo "==> prebuilt image not accessible (private package / no creds) -- building from source"
    echo "    make the GHCR package public, or 'docker login ghcr.io' on this box, to skip builds"
    break
  fi
  echo "==> waiting for docker.yml to publish $IMG:$SHA ($i/12)…"
  sleep 15
done

PROFILES=()
if [ -s tunnel.env ] && grep -q '^TUNNEL_TOKEN=.\+' tunnel.env; then
  PROFILES=(--profile tunnel); echo "==> tunnel token present"
fi

if [ "$prebuilt" = 1 ]; then
  # Tag it as the name compose expects, then run WITHOUT --build so compose uses it.
  docker tag "$IMG:$SHA" tripleucrypt:local
  echo "==> using prebuilt image (no local build)"
  docker compose "${PROFILES[@]}" up -d
else
  echo "==> building from source (fallback)"
  docker compose "${PROFILES[@]}" up -d --build
fi

# The tuc_data volume keeps whatever ownership it was seeded with, so if the image's
# app uid ever differs from the volume's, /app/data silently becomes unwritable (this
# happened once: adding packages shifted the auto-assigned uid, and settings + the
# trade-audit log stopped persisting without an error). The uid is pinned in the
# Dockerfile now; this realigns an already-seeded volume so an old one still works.
# Use --volumes-from so this works regardless of the compose project's volume prefix
# (the volume is "<project>_tuc_data", not "tuc_data" -- targeting the bare name silently
# creates a NEW empty volume and fixes nothing).
APP_UID=$(docker exec tripleucrypt id -u 2>/dev/null || echo "")
if [ -n "$APP_UID" ]; then
  VOL_OWNER=$(docker exec tripleucrypt stat -c %u /app/data 2>/dev/null || echo "")
  if [ -n "$VOL_OWNER" ] && [ "$VOL_OWNER" != "$APP_UID" ]; then
    echo "==> data volume owned by uid $VOL_OWNER but app runs as $APP_UID -- realigning"
    docker run --rm --volumes-from tripleucrypt --entrypoint chown alpine -R "$APP_UID:$APP_UID" /app/data || true
  fi
fi

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

log "telemetry sampler (answers 'is it stable over weeks' with a trend, not one reading)"
cat > /usr/local/bin/tuc-sample <<'SAMPLE_EOF'
#!/usr/bin/env bash
# One line of health+resource telemetry, appended every 15 min by a systemd timer.
# Exists so "is it stable over 5 weeks?" is answered with a trend instead of a
# single reading. Cheap: one docker inspect + one /health call.
set -uo pipefail
OUT=/var/log/tuc-samples.jsonl
TS=$(date -u +%FT%TZ)
MEM=$(docker stats --no-stream --format '{{.MemUsage}}' tripleucrypt 2>/dev/null | awk '{print $1}')
CPU=$(docker stats --no-stream --format '{{.CPUPerc}}' tripleucrypt 2>/dev/null | tr -d '%')
UP=$(docker inspect -f '{{.State.StartedAt}}' tripleucrypt 2>/dev/null)
RESTARTS=$(docker inspect -f '{{.RestartCount}}' tripleucrypt 2>/dev/null)
H=$(docker exec tripleucrypt curl -fsS --max-time 5 http://localhost:8200/health 2>/dev/null)
OK=$(echo "$H" | jq -r '.ok // "null"' 2>/dev/null)
DEG=$(echo "$H" | jq -r '.degraded // "null"' 2>/dev/null)
LOOPRS=$(echo "$H" | jq -r '[.tasks[]?.restarts] | add // 0' 2>/dev/null)
HOSTMEM=$(free -m | awk 'NR==2{print $3}')
printf '{"ts":"%s","mem":"%s","cpu":"%s","started":"%s","c_restarts":%s,"ok":%s,"degraded":%s,"loop_restarts":%s,"host_mem_mb":%s}\n' \
  "$TS" "${MEM:-?}" "${CPU:-?}" "${UP:-?}" "${RESTARTS:-0}" "${OK:-null}" "${DEG:-null}" "${LOOPRS:-0}" "${HOSTMEM:-0}" >> "$OUT"
SAMPLE_EOF

cat > /usr/local/bin/tuc-trend <<'TREND_EOF'
#!/usr/bin/env bash
# Summarise the telemetry samples: is memory creeping, is anything restarting?
F=/var/log/tuc-samples.jsonl
[ -s "$F" ] || { echo "no samples yet (timer runs every 15 min)"; exit 0; }
echo "samples: $(wc -l < "$F")  window: $(head -1 "$F" | jq -r .ts) -> $(tail -1 "$F" | jq -r .ts)"
echo
jq -rs '
  map(.mem_mb = (.mem | sub("MiB";"") | tonumber? // 0)) |
  "container memory MiB   first=\(.[0].mem_mb)  last=\(.[-1].mem_mb)  min=\(map(.mem_mb)|min)  max=\(map(.mem_mb)|max)",
  "container restarts     \(.[-1].c_restarts)",
  "background loop restarts (cumulative)  \(.[-1].loop_restarts)",
  "health ok=false samples  \([.[] | select(.ok != true)] | length)",
  "degraded samples         \([.[] | select(.degraded == true)] | length)"
' "$F"
echo
echo "last 5 samples:"; tail -5 "$F" | jq -c '{ts,mem,cpu,ok,loop_restarts}'
TREND_EOF

chmod 0755 /usr/local/bin/tuc-sample /usr/local/bin/tuc-trend

cat > /etc/systemd/system/tuc-sample.service <<'UNIT'
[Unit]
Description=Sample TripleUCrypt health/resource telemetry
[Service]
Type=oneshot
ExecStart=/usr/local/bin/tuc-sample
UNIT

cat > /etc/systemd/system/tuc-sample.timer <<'UNIT'
[Unit]
Description=Sample TripleUCrypt telemetry every 15 minutes
[Timer]
OnBootSec=3min
OnUnitActiveSec=15min
Persistent=true
[Install]
WantedBy=timers.target
UNIT

cat > /etc/logrotate.d/tuc-samples <<'CONF'
/var/log/tuc-samples.jsonl {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  copytruncate
}
CONF
systemctl daemon-reload
systemctl enable --now tuc-sample.timer >/dev/null 2>&1 || true

log "provisioning complete"
echo
echo "deploy public key (register read-only on the repo):"
cat /root/.ssh/tuc_deploy.pub
