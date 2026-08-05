#!/usr/bin/env bash
# One-command deploy. Run from anywhere: deploy/up.sh
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is required: https://docs.docker.com/get-docker/" >&2; exit 1
fi

if [ ! -f .env ]; then
  cp .env.example .env
  echo "→ Created deploy/.env. Edit it (TUC_API_URL + TUNNEL_TOKEN), then run this again."
  exit 1
fi

# Compose auto-loads ./.env from this directory.
docker compose up -d --build

cat <<EOF

✓ Up. The tunnel goes live once the app is healthy (~1–2 min on first build).
  Logs:   docker compose -f deploy/docker-compose.yml logs -f
  Status: docker compose -f deploy/docker-compose.yml ps
  Visit:  \$TUC_API_URL  (from deploy/.env)
EOF
