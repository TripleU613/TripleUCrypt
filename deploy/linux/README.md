# Linux host provisioning (VPS / droplet)

`provision.sh` turns a fresh **Ubuntu 24.04** box into a TripleUCrypt host. It is
ASCII-only and **idempotent** — safe to re-run to repair or update the host
config.

Used for the DigitalOcean **tor1 (Toronto)** production host. Any Ubuntu 24.04
VPS works.

## What it sets up

| | |
|---|---|
| **Docker CE** | official apt repo, plus daemon-level log rotation (10 MB × 3) |
| **App** | built from source in-place, run under compose, `restart: unless-stopped` |
| **Auto-start** | `tripleucrypt.service` brings the stack up on boot — no rebuild, no network fetch, so a GitHub/registry outage can't stop the box coming back |
| **Firewall** | `ufw`: inbound **SSH only**. The app is never published to the internet |
| **SSH** | keys only (`PasswordAuthentication no`, `PermitRootLogin prohibit-password`) |
| **Swap** | 2 GB — a 2 GB box running `vite build` will otherwise OOM mid-deploy |
| **Patching** | `unattended-upgrades` enabled |
| **Repo access** | a read-only GitHub **deploy key**, generated *on the box* |

## Why build from source instead of pulling the image

`ghcr.io/tripleu613/tripleucrypt` is **private**, so pulling it would mean
putting a registry credential on the host. Building from a read-only deploy key
is a narrower credential — it can read one repo and nothing else.

## Why the deploy key is generated on the box

Its private half never passes through droplet metadata, a chat log, CI, or
anyone's clipboard. Only the public half leaves, to be registered read-only:

```bash
ssh root@<host> 'cat /root/.ssh/tuc_deploy.pub'   # then, locally:
gh repo deploy-key add key.pub --title "<host> (read-only)"
```

## Usage

```bash
scp provision.sh root@<host>:/root/
ssh root@<host> '/root/provision.sh'      # then register the deploy key, above
ssh root@<host> 'tuc-deploy'              # clone, build, start, wait for health
```

## Commands on the host

| Command | Does |
|---|---|
| `tuc-deploy` | pull latest `main`, rebuild, restart, wait for health |
| `tuc-status` | containers, `/health` (incl. per-loop liveness), deployed commit, resources |
| `tuc-logs [n]` | follow logs |
| `tuc-tunnel [token]` | provision the Cloudflare Tunnel token and start `cloudflared` |
| `tuc-secrets` | edit live-trading creds in `$EDITOR`, then restart |

## Networking

The app binds **`127.0.0.1:8200`** only — it is not reachable from the internet
(verify with `curl http://<host>:8200/health` from elsewhere; it must fail).
`cloudflared` runs with `network_mode: host` and reaches it at
`http://localhost:8200`, which matches the tunnel ingress used by the native
Windows install — so **no Cloudflare-side change is needed** when migrating.

> If your tunnel's Public Hostname points at `http://app:8200` instead, either
> change it to `http://localhost:8200`, or drop `network_mode: host` from the
> `cloudflared` service in `/opt/tripleucrypt/docker-compose.yml`.

**Running the same tunnel token in two places makes Cloudflare load-balance
between them** — traffic would land on the old host half the time. Stop the old
`cloudflared` before (or as) you start the new one.

## Secrets

`/opt/tripleucrypt/secrets.env` (mode `0600`) is empty by default, so the host
runs in **practice (paper) mode**. Add live credentials with `tuc-secrets`, which
is interactive on purpose — a wallet private key should never end up in a chat
transcript, a CI log, or shell history.

All on-chain write paths stay **default-OFF** regardless, until armed by the
in-app "Enable trading" confirm or by setting `TUC_EOA_APPROVE_ENABLED` /
`TUC_REDEEM_ENABLED` / `TUC_SWAP_ENABLED`.

## Data

Persists in the `tuc_data` named volume mounted at `/app/data`
(`TC_DATA_DIR=/app/data`): paper ledger, settings, window history, trade audit
log, and any generated trading wallet key.

A **named volume, not a bind mount** — Docker seeds it with the image's
ownership so the container's non-root `tripleu` user can write to it. A
root-owned host bind mount could not.

```bash
# Back up the data volume (includes a generated wallet key, if any -- treat as secret)
ssh root@<host> 'docker run --rm -v tripleucrypt_tuc_data:/d -v /tmp:/b alpine \
  tar czf /b/tuc-data.tgz -C /d .'
scp root@<host>:/tmp/tuc-data.tgz .
```
