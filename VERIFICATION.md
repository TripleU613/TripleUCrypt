# Live-money verification runbook

Everything in the money path has been hardened by static review and unit tests.
**None of it has moved a real dollar.** There is a class of failure that only
appears against the live CLOB with a funded wallet, and no amount of code review
finds it.

This runbook converts four unknowns into four knowns for **about $4 and twenty
minutes**. Do it once, in order, before trusting real size.

> Run it on a **quiet market** (a 15m window with time left), not in the last 30
> seconds of a 5m window. You are testing plumbing, not timing.

---

## 0 · Setup (once)

```bash
ssh -i ~/.ssh/tripleucrypt_tor1 root@<host>
tuc-secrets            # add POLY_PRIVATE_KEY + POLY_WALLET_ADDRESS, then save
tuc-status             # ok=true, 10 loops alive
```

Fund the wallet with a little **USDC.e on Polygon** (~$10) plus **~1 POL** for
gas. Then in the app: **Wallet → Enable trading** and accept the confirm — this
arms the on-chain write paths, which are default-OFF.

Keep two things open while you work:

```bash
tuc-logs 50                                   # terminal 1: live server log
tail -f /root/.triplecrypt/trade_audit.jsonl  # terminal 2: the audit trail
# (or wherever TC_DATA_DIR points -- /app/data inside the container)
```

**Rule for every step below: if the audit line and the UI disagree, stop.** That
disagreement is the bug, and it is exactly what the reconciler was built to
catch.

---

## 1 · Buy $1

Pick a market ~50c so one dollar buys ~2 shares. Set size to **$1**, hit Buy.

**Pass looks like:**

| Where | What |
|---|---|
| UI | `Bought 1.9x UP @ 5x¢` |
| `trade_audit.jsonl` | one `"action":"buy"` line with matching `shares`/`price_cents`, and a non-empty `ref` (the CLOB order id) |
| Positions | the position appears within a few seconds |
| Log | **no** `[reconcile]` line |

**Fail modes and what they mean:**

- `Not enough USDC - $1.00 order, $0.00 available` -> the balance read is
  failing, not your wallet. Check `tuc-logs` for `cash() error`.
- `Trading not approved yet` -> you skipped **Enable trading**, or the approval tx
  never landed. Check POL balance.
- **`[reconcile] BUY ... Filled N shares but only M confirmed`** -> the important
  one. The exchange reported a fill the position book does not show. Stop and
  check Polymarket directly before trading again.
- `Order submitted - confirming...` and it never resolves -> the order posted but
  matched nothing. Not a loss; the size or price did not cross. Retry with
  market mode.

---

## 2 · Sell it back

Sell the whole position.

**Pass:** `Sold 1.9x shares @ 5x¢`, a `"action":"sell"` audit line, the position
disappears, **no** `[reconcile]` line, and cash returns (minus the spread — you
will lose a cent or two crossing the book, which is correct, not a bug).

**The fail that matters:** `Sell reported, but N shares are still held`. That
means the app told you that you were out while you were still exposed. Treat as
critical — do not trade further until understood.

---

## 3 · Claim a winner

Buy $1 on a side you think wins, let the window resolve, then **Claim**.

**Pass:** `Claimed 1 winning position(s)`, an `"action":"claim"` audit line with
`ref` set to the **on-chain tx hash**, and cash increases by ~$1 per winning
share. Paste that hash into polygonscan to confirm it landed.

If claim reports 0, the audit line records the broker's actual error rather than
a false success. `Neg-risk redemption not yet supported` should **not** appear —
these up/down markets report `neg_risk=false` (verified against live data).

---

## 4 · Withdraw $1

Wallet -> Send/Withdraw, $1, to an address you control. Review, confirm.

**Pass:** a tx hash you can find on polygonscan, and the funds arrive.

This is the least-exercised path in the codebase. Do it with $1 and check the
destination address character by character before confirming.

---

## 5 · Then leave it alone

Load the terminal and **leave the tab open for a full day.** This is the bug you
originally reported, and the fix needs wall-clock time to prove.

```bash
tuc-trend        # after a day or two
```

**Pass:** container memory flat (~100 MiB), `container restarts 0`, few or no
`loop restarts`, no `degraded` samples. Prices and windows still ticking in the
UI, with no stale panels.

Some background-loop restarts are **fine and expected** — that is the supervisor
recovering a dropped upstream, which is the system working. What matters is that
the number is not climbing continuously.

If memory has climbed meaningfully, that is a real leak worth chasing with the
sample data in hand rather than guesses.

---

## What this does and does not prove

**Proves:** signing works against the real CLOB; orders match; positions settle;
claims redeem on-chain; withdrawals leave; the streams survive a day.

**Does not prove:** behaviour under a thin or fast-moving book, behaviour when
Polymarket degrades, or the browser-wallet ("Wallet") signing mode — that is a
separate path and needs its own pass with the extension connected. See
`WALLET_SIGNING_PLAN.md`.

**Known and unfixable locally:** the `elliptic` library on the signing path has an
unpatched advisory where a rare nonce case yields a malformed signature. The
practical outcome is a rejected order, not lost funds. No upstream patch exists
and `@polymarket/clob-client-v2` pins the vulnerable chain itself, so this is a
watch-item.

---

## If money ever goes missing

1. `grep unreconciled /root/.triplecrypt/trade_audit.jsonl` — every fill the app
   could not verify is recorded there with what it actually observed.
2. Cross-check the `ref` (order id / tx hash) against Polymarket and polygonscan.
   On-chain is the truth; this app is a client.
3. The audit log survives restarts and deploys (it lives in the `tuc_data`
   volume), so the trail is still there after the fact.
