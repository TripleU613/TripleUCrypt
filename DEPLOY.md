# Deploy TripleUCrypt to your own domain

Serve the app at `https://yourdomain.com` from **any** host with Docker — your
PC, a VPS, a droplet — behind a **Cloudflare Tunnel** with a **Cloudflare Access
login gate on by default**. No open ports, no static IP, no manual TLS, and not
open to the public.

```
you ──https + login──> Cloudflare (TLS + Access) ──tunnel──> cloudflared ──> app:8200
     (only allowed emails get in)                            (this host, no open ports)
```

## You need

- A **domain** you own, and a free **Cloudflare** account.
- **Docker** on the host that runs it.

## 1 · Domain → Cloudflare (free)

Cloudflare dashboard → **Add a site** → your domain → **Free** plan. It gives you
two **nameservers** — set those at your registrar. Wait until the site shows
**Active**.

## 2 · Create the Tunnel

**Zero Trust → Networks → Tunnels → Create a tunnel → Cloudflared.** Name it,
save, and **copy the token** (the long string after `--token`). That's your
`TUNNEL_TOKEN`.

Add a **Public Hostname**: your subdomain (e.g. `trade.yourdomain.com`) →
type **HTTP** → URL **`app:8200`**.

## 3 · Lock it down with Access (default)

**Zero Trust → Access → Applications → Add an application → Self-hosted.**

- **Application domain:** the same hostname (`trade.yourdomain.com`).
- **Policy:** Action **Allow**, rule **Emails** → your email(s).

Now only those emails can reach the app — Cloudflare shows a login screen first.
This is the default for good reason: it's a real-money terminal; don't run it
open. (To make it public instead, simply don't add the Access application.)

## 4 · Launch (one command)

```bash
git clone https://github.com/TripleU613/TripleUCrypt
cd TripleUCrypt/deploy
cp .env.example .env        # set TUC_API_URL=https://trade.yourdomain.com
                            #     TUNNEL_TOKEN=<your token>
./up.sh
```

`./up.sh` pulls the published image and starts everything — the app is
domain-agnostic (the client calls same-origin relative paths), so it works
behind whatever hostname you route to it with no rebuild. The tunnel only goes
live **once the app is healthy** (~30–60s on first pull), so visitors never
catch a 502. Then open **https://trade.yourdomain.com**, sign in through
Access, and you're on your terminal.

> **While the repo is private, so is the image.** `ghcr.io/tripleu613/tripleucrypt`
> cannot be pulled anonymously, so this path needs
> `docker login ghcr.io -u <user> -p <token-with-read:packages>` first — or make
> the GHCR **package** public (its visibility is set separately from the repo's).
> To avoid a registry credential on the host entirely, build from source instead:
> see [deploy/linux/README.md](deploy/linux/README.md), which is what the
> production host does.

```bash
# from the deploy/ dir
docker compose logs -f      # watch
docker compose ps           # status
docker compose down         # stop
```

## Live trading (optional)

Practice mode (virtual $100) needs nothing. For **real money**, put your
Polymarket creds in `deploy/secrets.env` (same keys as the repo-root
`.env.example` — only `POLY_PRIVATE_KEY` + `POLY_WALLET_ADDRESS` are required)
and `./up.sh` again — `deploy/docker-compose.yml` already loads `secrets.env`
when present (it's optional and git-ignored).

> ⚠️ Live mode places real, irreversible on-chain orders; Polymarket is
> geo-restricted (incl. the US). See the [README](README.md) disclaimer.

## Stability & ops

- **Auto-restart:** both services use `restart: unless-stopped` — they survive
  crashes and host reboots.
- **Persistent data:** the practice-mode ledger and (if you use the generated
  wallet instead of `POLY_PRIVATE_KEY`) its key live in the `tripleucrypt_data`
  volume, so they survive `./up.sh` re-runs and image updates.
- **Health-gated tunnel:** `cloudflared` waits for the app's healthcheck, so the
  domain never serves a half-started app.
- **Pinned tunnel:** `cloudflared` is pinned to a known-good tag.
- **Update:** `git pull && cd deploy && ./up.sh` (pulls the latest published image).

## Update

```bash
git pull
cd deploy && ./up.sh
```

## Continuous deploy to your own server (always-on)

This is a production setup behind your own domain: a **Linux VPS running the
app in Docker**, fronted by Cloudflare Tunnel + Access, redeployed on every push
to `main` by `.github/workflows/deploy.yml`.

> **Previously** this was a self-hosted GitHub Actions runner on a native
> Windows box (NSSM service + robocopy mirror). That is retired. A self-hosted
> runner also fails badly when the machine is off: deploys sit **queued**
> indefinitely rather than failing, so pushes look successful while production
> never updates.

### One-time: the host

Any Ubuntu 24.04 VPS. `deploy/linux/provision.sh` does the whole setup —
Docker, the app under compose, systemd auto-start, `ufw` (inbound SSH only),
key-only SSH, swap, unattended-upgrades. It is idempotent, so re-run it to
repair a host. Full detail: **[deploy/linux/README.md](deploy/linux/README.md)**.

```bash
scp deploy/linux/provision.sh root@<host>:/root/
ssh root@<host> '/root/provision.sh'

# Register the deploy key it generated (read-only, and generated ON the host so
# its private half never travels):
ssh root@<host> 'cat /root/.ssh/tuc_deploy.pub' > key.pub
gh repo deploy-key add key.pub --title "<host> (read-only)"

ssh root@<host> 'tuc-deploy'      # clone, build, start, wait for health
```

### One-time: CI secrets (GitHub → Settings → Secrets → Actions)

```bash
gh secret set DROPLET_HOST --body "<host ip>"
gh secret set DROPLET_SSH_KEY < ~/.ssh/<ci_key>          # private half
ssh-keyscan -t ed25519 <host ip> | gh secret set DROPLET_KNOWN_HOSTS
```

Add the CI key's **public** half to the host pinned to a forced command, so a
leaked CI key cannot open a shell or forward ports — only run the deploy:

```
command="/usr/local/bin/tuc-deploy",no-port-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... github-actions-deploy
```

**Money credentials are deliberately NOT in CI.** They live only in
`/opt/tripleucrypt/secrets.env` on the host (`tuc-secrets`), so a wallet private
key never passes through GitHub. Without them the host runs in practice mode.

### One-time: Cloudflare (domain + tunnel + Access)

1. Add your domain to Cloudflare (Free plan); point your registrar's
   nameservers at it.
2. **Zero Trust → Networks → Tunnels → Create** → Cloudflared → copy the token.
3. **Public Hostname**: `trade.example.com` → **HTTP** → `localhost:8200`.
   (The host binds the app to `127.0.0.1:8200` and runs `cloudflared` with
   `network_mode: host`, so `localhost` is correct. If you prefer `app:8200`,
   drop `network_mode: host` from the compose file.)
4. **Zero Trust → Access → Applications → Add → Self-hosted**: your domain,
   policy **Allow → Emails → you**. Login gate — on by default for a
   live-money terminal.
5. Install the token on the host: `ssh root@<host> 'tuc-tunnel'` (prompts, so the
   token stays out of your shell history).

> Running the **same tunnel token in two places** makes Cloudflare load-balance
> between them, so traffic lands on the old host part of the time. Stop the old
> `cloudflared` before starting the new one.

That's it. Every push to `main` then redeploys: pull `main` on the host via the
read-only deploy key, rebuild the image, restart, and wait for `/health`.
`tuc-deploy` exits non-zero if the app never reports healthy, so a bad rollout
fails the job. Trigger manually with **Actions → Deploy to server → Run**.

**On a failed deploy** the previous container keeps running (`restart:
unless-stopped`) and the previous image is still present, so the app should stay
up while you inspect `tuc-status` / `tuc-logs`.

### Latency (when the server is far from you)

This stays snappy even with an ocean between you and the server, because the
**live price, order-book and trade-activity feeds stream from your browser
directly to Polymarket/Kraken** — they do **not** route through the server.
Only the SSE state stream and action dispatch go browser↔server (~80–100 ms
RTT at intercontinental distance), which only affects click/UI latency, not
the live numbers. Cloudflare also terminates TLS at an edge near you. If UI feel ever
matters more than location, move the box to a region near you — but the market
data won't change either way.

## Alternative: public IP + Caddy

If you'd rather use a host with a public IP and ports 80/443 open, run the image
with `-p 8200:8200` and put Caddy in front for automatic Let's Encrypt TLS:

```
trade.yourdomain.com {
    reverse_proxy localhost:8200
}
```

Cloudflare Tunnel is the default because it needs neither open ports nor a
static IP, and brings Access (auth) for free.
