# TripleUCrypt — Docker Deployment

## Quick Start

```bash
# 1. Clone
git clone https://github.com/TripleU613/TripleUCrypt.git
cd TripleUCrypt

# 2. Set up credentials (optional — without them the app starts in practice mode,
#    and browser-wallet signing needs no credentials at all)
cp .env.example .env
# Edit .env with your wallet credentials

# 3. Build and run
docker compose up -d

# 4. Open
open http://localhost:8200
```

Done. The dashboard streams live BTC/ETH/SOL/XRP/DOGE/HYPE/BNB prices and
Polymarket UP/DOWN windows immediately.

---

## Requirements

- **Docker** 20.10+ and **Docker Compose** v2
- **RAM**: 1GB minimum, 2GB recommended
- **CPU**: 2 cores minimum
- **Network**: outbound HTTPS to Kraken + Polymarket APIs

---

## Ports

| Port | What |
|------|------|
| `8200` | Web UI + backend WebSocket API (open this in your browser) |

In the container the app runs in production mode, which serves **single-port**:
one Express server serves the built frontend, the SSE state stream, and the
API on `8200`. The 5173/8200 split (Vite/Express) only exists in local dev
mode (`npm run dev`).

---

## Credentials

Trading is **optional**. The app shows live prices and order books without any credentials.

To enable real order placement, only **two** vars are needed in `.env` — the
CLOB L2 API credentials are derived from your key automatically:

```bash
POLY_PRIVATE_KEY=0x...       # Your Ethereum (Polygon) wallet private key
POLY_WALLET_ADDRESS=0x...    # Your Polymarket (proxy/funder) wallet address
```

See `.env.example` for the optional extras (Polygon RPC override, deposit
history, the gated send feature).

---

## GPU Monitoring (NVIDIA)

The power manager uses `nvidia-smi` to optimize streaming intervals.
Works without GPU — falls back gracefully.

**To enable GPU support:**
1. Install [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/install-guide.html)
2. Uncomment the GPU section in `docker-compose.yml`

---

## Useful Commands

```bash
# Start
docker compose up -d

# Stop
docker compose down

# View logs (live)
docker compose logs -f

# Restart
docker compose restart

# Update to latest
git pull
docker compose build --no-cache
docker compose up -d

# Check health
docker compose ps

# Shell into container
docker compose exec tripleucrypt bash
```

---

## Nginx Reverse Proxy (Port 80)

To serve on port 80 with a domain:

```nginx
server {
    listen 80;
    server_name your-domain.com;

    # Single upstream — the container serves UI + WebSocket API on one port.
    location / {
        proxy_pass http://localhost:8200;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Docker Container (single port :8200)           │
│                                                 │
│  ┌─────────────┐    ┌────────────────────────┐  │
│  │  React      │    │  Express (Node.js)    │  │
│  │  (static,   │◄──►│  Backend               │  │
│  │  built by   │    │  :8200                 │  │
│  │  Vite)      │    │                        │  │
│  └─────────────┘    │                        │  │
│                     │  ┌──────────────────┐  │  │
│                     │  │ Background Tasks  │  │  │
│                     │  │ • Kraken WS      │  │  │
│                     │  │ • Polymarket WS  │  │  │
│                     │  │ • Tick engine    │  │  │
│                     │  │ • Power manager  │  │  │
│                     │  └──────────────────┘  │  │
│                     └────────────────────────┘  │
└─────────────────────────────────────────────────┘
         │                        │
    Kraken API             Polymarket CLOB
```
