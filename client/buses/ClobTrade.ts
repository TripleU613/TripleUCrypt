/**
 * ClobTrade — Browser-mode trading. Places Polymarket CLOB orders signed by the
 * connected wallet (MetaMask), entirely client-side. Mirrors LiveBroker.buy/sell
 * (src/banking/live.ts) but the signer is the user's wallet, not a server key.
 *
 * Used only when Wallet Mode = "Browser" (sign_mode === 'wallet'). Server mode
 * keeps signing server-side.
 */

import { providers } from 'ethers'
import { ClobClient, Side, OrderType } from '@polymarket/clob-client-v2'
import type { ApiKeyCreds } from '@polymarket/clob-client-v2'
import { getEip1193, approveErc20, setApprovalForAll } from './MetaMaskBus.js'
import { useStore } from '../store.js'
import { getPolyFunder } from '../lib/polyFunder.js'

// Route CLOB through our own server (/clob → clob.polymarket.com) so browser
// requests are same-origin — no CORS / Cloudflare-bot / network-error issues.
// clob-client signs the relative path (e.g. /order), so the host prefix is safe.
const CLOB_HOST = (typeof window !== 'undefined' ? window.location.origin : '') + '/clob'
const CHAIN = 137
// Polymarket signature types (SignatureTypeV2 in the SDK):
//   0 EOA               -- the signing EOA is also the maker and holds the funds
//   2 POLY_GNOSIS_SAFE  -- an EOA signing for the Polymarket Safe proxy it owns
//
// Browser mode was hardcoded to 0 with funderAddress = the MetaMask address, which
// tells the CLOB "this bare EOA is the maker". If you connected MetaMask to
// Polymarket, your funds live in a Gnosis Safe PROXY it created for you, and that
// proxy -- not your EOA -- is the allowed maker. The CLOB rejects the EOA with
// "maker address not allowed. please use the deposit market flow".
const SIG_TYPE_EOA = 0
const SIG_TYPE_POLY_GNOSIS_SAFE = 2


/**
 * Which (funder, signatureType) pair to trade with.
 *
 * The rule is general and mirrors src/banking/live.ts: if the funder differs from
 * the signer, the signer is acting FOR a proxy (type 2). If they are the same, the
 * EOA is its own maker (type 0) -- valid only for an EOA that has itself been
 * onboarded and approved on-chain, which is the generated-wallet case, not a
 * freshly connected MetaMask.
 */
export function fundingAccount(signerAddr: string): string {
  const proxy = getPolyFunder()
  return proxy || signerAddr
}

function makerFor(signerAddr: string): { funder: string; sigType: number } {
  const proxy = getPolyFunder()
  if (proxy && proxy.toLowerCase() !== signerAddr.toLowerCase()) {
    return { funder: proxy, sigType: SIG_TYPE_POLY_GNOSIS_SAFE }
  }
  return { funder: signerAddr, sigType: SIG_TYPE_EOA }
}
const CREDS_KEY = 'tc_clob_creds'

// Polygon contract addresses (public; mirror src/banking/models.ts).
const USDC_E = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'
const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'
// Binary up/down markets settle through the standard CTF Exchange only, so we
// approve just that one (2 txs) — not the neg-risk contracts (which would be 6).
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'
const NEG_RISK_EXCHANGE = '0xC5d563A36AE78145C45a50134d48A1215220f80a'
const NEG_RISK_ADAPTER = '0xd91E80cF2E7be2e162c6513ceD06f1dD0dA35296'
const SPENDERS = [
  CTF_EXCHANGE,
  NEG_RISK_EXCHANGE,
  NEG_RISK_ADAPTER,
]

// Slippage maths lives in lib/slippage.ts so callers can use it WITHOUT pulling
// this module's web3 dependencies into the eager bundle. Re-exported here so
// ClobTrade's own public surface is unchanged.
export { MAX_SLIPPAGE, DEFAULT_TICK, slippageCapCents, slippageFloorCents } from '../lib/slippage.js'

export interface BrowserFill { ok: boolean; error?: string; shares: number; price: number; usd: number; orderId: string; requested?: number; partial?: boolean }

let _client: ClobClient | null = null
let _clientAddr = ''

function signer(address: string): providers.JsonRpcSigner {
  const eip1193 = getEip1193()
  if (!eip1193) throw new Error('No wallet connected')
  // ethers v5 Web3Provider wraps the EIP-1193 provider. Pin getSigner() to the
  // explicit funder address so the signer matches the order's maker/funder even
  // when MetaMask's currently-selected account differs (wrong-account signing).
  return new providers.Web3Provider(eip1193 as unknown as providers.ExternalProvider).getSigner(address)
}

/**
 * Reset the in-memory, address-bound ClobClient / approval caches. Called on a
 * MetaMask account switch (or disconnect) so a stale client/creds/approval state
 * from the previous account can't be served for the new active address. The
 * per-address sessionStorage creds (`tc_clob_creds:<addr>`) are naturally scoped
 * by key, so the client is simply rebuilt for the new address on next use.
 */
export function resetClobCaches(): void {
  _client = null
  _clientAddr = ''
  _approving = false
  _approvedAddr = ''
  _negRiskApprovedAddr = ''
}

/** Lazily build a ClobClient bound to the wallet, deriving L2 creds once (1 popup). */
async function client(address: string): Promise<ClobClient> {
  if (_client && _clientAddr.toLowerCase() === address.toLowerCase()) return _client
  const sgn = signer(address)
  const slot = `${CREDS_KEY}:${address.toLowerCase()}`
  let creds: ApiKeyCreds | undefined
  const cached = sessionStorage.getItem(slot)
  if (cached) { try { creds = JSON.parse(cached) as ApiKeyCreds } catch { /* ignore */ } }

  // clob-client-v2 uses an options-object constructor.
  let c = new ClobClient({ host: CLOB_HOST, chain: CHAIN, signer: sgn, creds, signatureType: SIG_TYPE_EOA, funderAddress: address })
  if (!creds) {
    creds = await c.createOrDeriveApiKey() // one MetaMask signature
    sessionStorage.setItem(slot, JSON.stringify(creds))
    c = new ClobClient({ host: CLOB_HOST, chain: CHAIN, signer: sgn, creds, signatureType: SIG_TYPE_EOA, funderAddress: address })
  }
  _client = c; _clientAddr = address
  return c
}

/**
 * Read the REAL matched fill from a CLOB postOrder response (OrderResponse).
 * Truth comes from makingAmount/takingAmount, not from the presence of an
 * orderID or a non-error status. A FOK/FAK marketable order that is KILLED or
 * fills 0 still returns an orderID + a live/delayed status — that is NOT a fill.
 *   BUY:  makingAmount = USD spent,   takingAmount = shares received
 *   SELL: makingAmount = shares sold, takingAmount = USD received
 * `requested` is the order's requested size (USD for BUY, shares for SELL) so
 * the caller can detect a partial FAK sell (matched < requested).
 */
export function parseFill(resp: unknown, side: 'BUY' | 'SELL', usd: number, shares: number): BrowserFill {
  const r = (resp ?? {}) as Record<string, unknown>
  const oid = String(r['orderID'] ?? r['orderId'] ?? r['id'] ?? '')
  const making = parseFloat(String(r['makingAmount'] ?? 0)) || 0
  const taking = parseFloat(String(r['takingAmount'] ?? 0)) || 0
  // Matched USD / shares depend on side.
  const matchedUsd = side === 'BUY' ? making : taking
  const matchedShares = side === 'BUY' ? taking : making
  const priceCents = matchedShares > 0 ? Math.round((matchedUsd / matchedShares) * 100 * 100) / 100 : 0
  // A fill is real ONLY when a positive size actually matched.
  const ok = matchedShares > 0 && matchedUsd > 0
  const requested = side === 'BUY' ? usd : shares
  const matched = matchedShares
  const partial = side === 'SELL' && ok && matched + 1e-6 < requested
  const err = ok ? '' : String(r['errorMsg'] ?? r['error'] ?? 'Order not filled').slice(0, 160)
  return {
    ok,
    orderId: oid,
    error: err || undefined,
    shares: Math.round(matchedShares * 1e4) / 1e4,
    price: priceCents,
    usd: Math.round(matchedUsd * 100) / 100,
    requested,
    partial,
    side,
  } as unknown as BrowserFill
}

/**
 * Detect an auth-type failure from either a THROWN error or a RETURNED response.
 * The clob-client swallows axios errors in postOrder and RETURNS `{ error, status }`
 * (so a revoked/rotated key surfaces as a returned 401 / "invalid api key" object,
 * NOT a thrown exception), while createL2Headers / canL2Auth can THROW. We cover
 * both: a 401 status, or a message/error string matching known auth phrasings.
 */
/**
 * "maker address not allowed, please use the deposit wallet flow" means the maker we
 * signed for is not a registered Polymarket account -- almost always because we
 * traded as the bare EOA while the user's collateral sits in a Safe proxy. Rewrite
 * it into the actual remedy; the raw text gives no hint that a proxy address is
 * what's missing.
 */
function friendlyClobError(raw: string): string {
  if (/maker address not allowed|deposit (wallet|market) flow/i.test(raw)) {
    return 'Polymarket rejected this wallet as the maker. Your funds are held by a '
         + 'Polymarket wallet (Safe proxy), not your browser wallet — paste its '
         + 'address into "Polymarket wallet (maker)" in the Wallet panel. Find it on '
         + 'Polymarket → Deposit.'
  }
  return raw
}

function isAuthError(x: unknown): boolean {
  if (x == null) return false
  const r = x as Record<string, unknown>
  const status = Number(r['status'] ?? (r['response'] as Record<string, unknown> | undefined)?.['status'] ?? NaN)
  if (status === 401) return true
  const parts = [
    (x as Error)?.message,
    r['error'],
    r['errorMsg'],
    r['msg'],
  ].map(v => (typeof v === 'string' ? v : '')).join(' ').toLowerCase()
  return /invalid api key|unauthorized|api credentials|not authenticated|auth(?:entication| failed)|\b401\b/.test(parts)
}

/** Forget the cached creds for `address` (sessionStorage slot + in-memory client),
 *  so the next client(address) call re-derives a fresh key (one MetaMask popup). */
function clearCredsCache(address: string): void {
  try { sessionStorage.removeItem(`${CREDS_KEY}:${address.toLowerCase()}`) } catch { /* ignore */ }
  if (_clientAddr.toLowerCase() === address.toLowerCase()) { _client = null; _clientAddr = '' }
}

/**
 * Place an order, and if it fails with an auth-type error (revoked/rotated key),
 * clear the cached creds, re-derive ONCE, and retry the order a single time.
 * `place` builds + posts the order against a freshly-resolved client and returns
 * the postOrder response. A single boolean `_retried` guard prevents any loop.
 */
async function withAuthRetry(
  address: string,
  place: (c: ClobClient) => Promise<unknown>,
): Promise<unknown> {
  let c = await client(address)
  try {
    const resp = await place(c)
    // postOrder swallows auth failures into a returned object — catch those too.
    if (isAuthError(resp)) {
      clearCredsCache(address)
      c = await client(address) // re-derive once
      return await place(c)
    }
    return resp
  } catch (e) {
    if (!isAuthError(e)) throw e
    // Thrown auth failure (e.g. createL2Headers/canL2Auth): re-derive once + retry.
    clearCredsCache(address)
    c = await client(address)
    return await place(c)
  }
}

/**
 * Ask the CLOB what it thinks of the configured maker, BEFORE any order is signed.
 *
 * getBalanceAllowance() is answered for whatever (funder, signatureType) the client
 * was built with, so it is the one call that distinguishes "Polymarket knows this
 * account and it holds collateral" from "this address is not a registered maker" --
 * which is the difference between a working setup and the opaque
 * "maker address not allowed, please use the deposit wallet flow" at order time.
 *
 * Used by the Wallet panel when an address is saved, so a wrong or un-onboarded
 * address is caught immediately rather than on the next trade attempt.
 */
export async function verifyMaker(
  signerAddr: string,
): Promise<{ ok: boolean; maker: string; sigType: number; balance?: number; error?: string }> {
  const { funder, sigType } = makerFor(signerAddr)
  try {
    const c = await client(signerAddr)
    const r = await (c as unknown as {
      getBalanceAllowance(p: { asset_type: string }): Promise<{ balance?: string }>
    }).getBalanceAllowance({ asset_type: 'COLLATERAL' })
    // Balance is in collateral micro-units (6dp).
    const bal = Number(r?.balance ?? 0) / 1e6
    return { ok: true, maker: funder, sigType, balance: Number.isFinite(bal) ? bal : 0 }
  } catch (e) {
    return { ok: false, maker: funder, sigType, error: friendlyClobError((e as Error)?.message || 'Could not verify') }
  }
}

/** Marketable BUY for `usd`, capped at `maxPriceCents` (FOK). MetaMask signs. */
export async function browserBuy(address: string, tokenId: string, usd: number, maxPriceCents = 99): Promise<BrowserFill> {
  try {
    const price = Math.max(0.001, Math.min(0.999, maxPriceCents / 100))
    const resp = await withAuthRetry(address, async (c) => {
      const order = await c.createMarketOrder({ tokenID: tokenId, amount: usd, side: Side.BUY, price })
      return c.postOrder(order, OrderType.FOK)
    })
    return parseFill(resp, 'BUY', usd, 0)
  } catch (e) { return { ok: false, error: friendlyClobError((e as Error)?.message || 'Order failed'), shares: 0, price: 0, usd, orderId: '' } }
}

/**
 * Re-read the FRESHEST held size (shares) for one token from the public data-api
 * `/positions`, right before selling. The polled portfolio snapshot can be up to
 * ~15s stale, so a prior partial sell / external sale / resolution can leave the
 * snapshot size larger than the real balance — selling that excess reverts after
 * signing. Returns the live size, or null when it can't be read (caller decides).
 * Also surfaces resolution: a resolved token must NOT be sold (route to claim).
 */
export async function freshHeldSize(address: string, tokenId: string): Promise<{ size: number; resolved: boolean } | null> {
  try {
    // Positions belong to the MAKER -- the proxy when one is configured. Querying
    // the signing EOA would report zero held and refuse the sell.
    const r = await fetch(`/data-api/positions?user=${fundingAccount(address)}&sizeThreshold=0`)
    const raw = await r.json() as DataApiPosition[] | { data?: DataApiPosition[] }
    const list = Array.isArray(raw) ? raw : (raw.data ?? [])
    const p = list.find(x => (x.asset ?? '') === tokenId)
    if (!p) return { size: 0, resolved: false }
    return { size: p.size ?? 0, resolved: positionResolution(p).resolved }
  } catch {
    return null
  }
}

/** SELL `shares`, floored at `minPriceCents` (FAK). MetaMask signs.
 *  `minPriceCents` MUST be the live best bid × (1 - MAX_SLIPPAGE) (tick-clamped).
 *  A missing/unusable floor means no live bid → refuse rather than dump at 1¢. */
export async function browserSell(address: string, tokenId: string, shares: number, minPriceCents?: number): Promise<BrowserFill> {
  try {
    if (!(typeof minPriceCents === 'number' && minPriceCents > 0)) {
      return { ok: false, error: 'No live bid — order not placed', shares: 0, price: 0, usd: 0, orderId: '' }
    }
    const price = Math.max(0.001, Math.min(0.999, minPriceCents / 100))
    const resp = await withAuthRetry(address, async (c) => {
      const order = await c.createOrder({ tokenID: tokenId, price, size: shares, side: Side.SELL })
      return c.postOrder(order, OrderType.FAK)
    })
    return parseFill(resp, 'SELL', 0, shares)
  } catch (e) { return { ok: false, error: friendlyClobError((e as Error)?.message || 'Order failed'), shares: 0, price: 0, usd: 0, orderId: '' } }
}

// ── One-time approvals (raw EOA must approve the exchanges before orders fill) ──

export interface AllowanceStatus { ready: boolean; missing_erc20: string[]; missing_ctf: string[]; tradeable?: boolean }

const _eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

/** Read-only approval status from the server (no key needed). `tradeable` = the
 *  CTF Exchange (what binary markets use) is approved. */
export async function readAllowance(address: string): Promise<AllowanceStatus | null> {
  try {
    const r = await fetch(`/allowance?address=${address}`)
    const j = await r.json() as { ok: boolean; status?: AllowanceStatus }
    if (!j.ok || !j.status) return null
    const st = j.status
    st.tradeable = !st.missing_erc20.some(s => _eq(s, CTF_EXCHANGE)) && !st.missing_ctf.some(s => _eq(s, CTF_EXCHANGE))
    return st
  } catch { return null }
}

// Guards so the approval flow can't loop / run concurrently (one popup storm max).
let _approving = false
let _approvedAddr = ''

// Track which address we've confirmed neg-risk approvals for (separate from the
// binary CTF cache so a binary "tradeable" cache can't mask a missing neg-risk one).
let _negRiskApprovedAddr = ''

/**
 * Is the token being traded a neg-risk (multi-outcome) market? The clob-client's
 * order builder routes such orders to the NEG_RISK_EXCHANGE, so they need that
 * exchange + the adapter approved. Determined via the public /neg-risk endpoint.
 * Returns null when it can't be determined (caller refuses rather than guesses).
 */
async function isNegRiskToken(address: string, tokenId: string): Promise<boolean | null> {
  try {
    const c = await client(address)
    // ClobClient.getNegRisk(tokenID) → boolean (public GET /neg-risk).
    const v = await (c as unknown as { getNegRisk(t: string): Promise<boolean> }).getNegRisk(tokenId)
    return typeof v === 'boolean' ? v : null
  } catch {
    return null
  }
}

/**
 * Ensure the wallet has approved the exchanges (ERC-20 USDC.e + CTF setApprovalForAll).
 * Sends only the missing approvals via MetaMask. Runs at most once per address and
 * never concurrently — re-calls are a no-op so it can't pop up repeatedly.
 *
 * Binary markets (the common case): approve ONLY the CTF Exchange → at most 2 popups
 * (unchanged — the user dislikes extra popups). Neg-risk markets additionally need
 * the NEG_RISK_EXCHANGE + NEG_RISK_ADAPTER approved, but ONLY when the token being
 * traded is actually neg-risk — never blanket-approved for binary markets. Pass the
 * `tokenId` so neg-risk can be detected on demand; if a neg-risk token's spenders
 * aren't approvable the trade is refused (rather than silently reverting after signing).
 */
export async function ensureBrowserApprovals(address: string, tokenId?: string): Promise<{ ok: boolean; error?: string }> {
  // Trading through a Polymarket proxy: its allowances were granted by Polymarket's
  // deposit flow when the proxy was created. Approving here would set allowances on
  // the EOA's own tokens (which hold nothing) and prompt for nothing useful.
  const proxy = getPolyFunder()
  if (proxy && proxy.toLowerCase() !== address.toLowerCase()) return { ok: true }
  if (_approving) return { ok: false, error: 'Approval already in progress' }
  _approving = true
  try {
    // ── Binary CTF Exchange approvals (unchanged 2-popup flow) ──────────────────
    if (_approvedAddr.toLowerCase() !== address.toLowerCase()) {
      const st = await readAllowance(address)
      if (!st) return { ok: false, error: 'Could not read approval status' }
      if (!st.tradeable) {
        // Only the CTF Exchange is needed for binary markets → at most 2 popups.
        if (st.missing_erc20.some(s => _eq(s, CTF_EXCHANGE))) {
          const r = await approveErc20(USDC_E, CTF_EXCHANGE, address)
          if (!r.ok) return { ok: false, error: r.error }
        }
        if (st.missing_ctf.some(s => _eq(s, CTF_EXCHANGE))) {
          const r = await setApprovalForAll(CTF_ADDRESS, CTF_EXCHANGE, address)
          if (!r.ok) return { ok: false, error: r.error }
        }
      }
      _approvedAddr = address
    }

    // ── Neg-risk approvals (on demand, only for an actual neg-risk token) ───────
    if (tokenId && _negRiskApprovedAddr.toLowerCase() !== address.toLowerCase()) {
      const neg = await isNegRiskToken(address, tokenId)
      if (neg === null) {
        return { ok: false, error: 'Could not verify market type — order not placed' }
      }
      if (neg) {
        // This token trades on the NEG_RISK_EXCHANGE; without these the order
        // reverts AFTER signing. Approve the neg-risk spenders now (extra popups
        // are unavoidable for neg-risk, but never hit binary markets).
        const st = await readAllowance(address)
        if (!st) return { ok: false, error: 'Could not read approval status' }
        for (const sp of [NEG_RISK_EXCHANGE, NEG_RISK_ADAPTER]) {
          if (st.missing_erc20.some(s => _eq(s, sp))) {
            const r = await approveErc20(USDC_E, sp, address)
            if (!r.ok) return { ok: false, error: r.error || 'Approve neg-risk trading first' }
          }
          if (st.missing_ctf.some(s => _eq(s, sp))) {
            const r = await setApprovalForAll(CTF_ADDRESS, sp, address)
            if (!r.ok) return { ok: false, error: r.error || 'Approve neg-risk trading first' }
          }
        }
        _negRiskApprovedAddr = address
      }
      // A binary token leaves _negRiskApprovedAddr unset so a later neg-risk token
      // is still checked — correct, and costs only a cached public GET.
    }

    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message || 'Approval failed' }
  } finally {
    _approving = false
  }
}

// ── Portfolio: read the connected wallet's positions + balances into the store ──
// In Browser mode the server doesn't track this wallet, so the client owns these.

interface DataApiPosition {
  asset?: string; conditionId?: string; outcome?: string; title?: string
  size?: number; avgPrice?: number; curPrice?: number; currentValue?: number
  cashPnl?: number; initialValue?: number; redeemable?: boolean; curPriceWinning?: boolean
}

/**
 * REAL resolution state from a data-api `/positions` row. The data-api marks a
 * resolved-and-claimable winner with `redeemable === true`; once a market
 * resolves the winning token's `curPrice` is pinned to 1 (loser → 0). Either
 * signal means the position is resolved and must route to CLAIM, never to the
 * normal CLOB sell path (selling a resolved token reverts after signing).
 */
function positionResolution(p: DataApiPosition): { resolved: boolean; redeemable: boolean } {
  const redeemable = !!p.redeemable
  // curPrice === 1 ⇒ the market resolved in this token's favour (winner pinned).
  const pricePinned = (p.curPrice ?? 0) >= 0.999
  return { resolved: redeemable || pricePinned, redeemable }
}

// Read the wallet's POLYGON balances from a public RPC — independent of whatever
// chain MetaMask is currently showing (so the top bar is correct even off-Polygon).
// Same-origin proxy (src/server/index.ts) rather than a public RPC directly: a
// direct call leaked the visitor's IP and the wallet address in the calldata.
const POLY_RPC = '/rpc'
const T_NATIVE_USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359'
const T_USDC_E = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174'
async function readPolygonBalances(addr: string): Promise<{ usdc: number; usdce: number; pol: number }> {
  const rpc = async (method: string, params: unknown[]) => {
    const r = await fetch(POLY_RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
    return (await r.json() as { result?: string }).result
  }
  const dec = (h: string | undefined, d: number) => (h && h.startsWith('0x') ? Number(BigInt(h)) / 10 ** d : 0)
  const bal = (tok: string) => rpc('eth_call', [{ to: tok, data: '0x70a08231' + '0'.repeat(24) + addr.slice(2) }, 'latest'])
  const [pol, usdc, usdce] = await Promise.all([rpc('eth_getBalance', [addr, 'latest']), bal(T_NATIVE_USDC), bal(T_USDC_E)])
  return { usdc: dec(usdc, 6), usdce: dec(usdce, 6), pol: dec(pol, 18) }
}

export async function refreshBrowserPortfolio(address: string): Promise<void> {
  const patch = useStore.getState()._patch
  // Capture the mode + active address at the START of this poll. A poll can be in
  // flight while the user flips sign_mode (wallet ↔ practice/server) or switches
  // MetaMask accounts; writing a late/stale on-chain balance into the store after
  // such a switch would bleed one mode's money into the other mode's display (and
  // vice-versa). Before each write below we re-read the store and SKIP if the mode
  // is no longer 'wallet' OR the active mm_address changed since this call started.
  const startMode = useStore.getState().sign_mode
  const startAddr = (useStore.getState().mm_address || '').toLowerCase()
  const stillCurrent = (): boolean => {
    const s = useStore.getState()
    return s.sign_mode === 'wallet'
      && startMode === 'wallet'
      && (s.mm_address || '').toLowerCase() === startAddr
  }
  // Balances — read from a public Polygon RPC (chain-agnostic), not the injected
  // provider (which returns 0 if MetaMask is on a different network).
  try {
    // Collateral and positions sit with the maker (the proxy when configured).
    const b = await readPolygonBalances(fundingAccount(address))
    // Drop late/stale responses: only write if still in wallet mode for the same
    // address this poll started for (ignore the result otherwise).
    if (!stillCurrent()) return
    patch({
      mm_usdc: b.usdc, mm_usdce: b.usdce, mm_pol: b.pol,
      // The connected wallet's USDC.e is its spendable trading cash (raw-EOA model).
      stat_spendable: b.usdce, stat_cash: b.usdce,
      stat_wallet: b.usdc + b.usdce, stat_has_wallet: true,
      wallet_native_usdc: b.usdc, wallet_usdc_e: b.usdce, wallet_total: b.usdc + b.usdce,
      wallet_address: address,
      // The server skips its refresh in Browser mode, so it never flips this — but
      // the top-bar chips render "—" until stats_fresh is true. Mark fresh here.
      stats_fresh: true,
    })
  } catch { /* leave balances */ }

  // Positions — public data-api, no key. Map to the store's position shape.
  try {
    const r = await fetch(`/data-api/positions?user=${fundingAccount(address)}&sizeThreshold=0.01`)
    const raw = await r.json() as DataApiPosition[] | { data?: DataApiPosition[] }
    const list = Array.isArray(raw) ? raw : (raw.data ?? [])
    const positions = list
      // Keep resolved/redeemable positions in the list — the SellPanel filters
      // claimable by resolved && redeemable and routes them to CLAIM. Dropping
      // them here would hide the claim banner and (worse) leave them looking like
      // plain sellable positions elsewhere.
      .filter(p => (p.size ?? 0) > 0)
      .map(p => {
        const dir = (p.outcome === 'Down' || p.outcome === 'DOWN') ? 'Down' : 'Up'
        const asset = (p.title ?? '').split(' ')[0] || '?'
        const { resolved, redeemable } = positionResolution(p)
        return {
          token: p.asset ?? '', condition_id: p.conditionId ?? '', outcome: p.outcome ?? dir,
          asset, shares: p.size ?? 0, avg_price: Math.round((p.avgPrice ?? 0) * 100),
          cur_price: Math.round((p.curPrice ?? 0) * 100), value: p.currentValue ?? 0,
          cost_basis: p.initialValue ?? 0, unrealized_pnl: p.cashPnl ?? 0,
          // Carry the REAL resolution/redeemable state (was hardcoded false).
          settled: resolved, resolved, redeemable,
          asset_dir_label: `${asset} ${dir}`, size_str: `${(p.size ?? 0).toFixed(1)} shares`,
        } as Record<string, unknown>
      })
    // Browser mode only: the server engine fills token_bids/token_asks for the
    // active window's two tokens only, so a position outside that window has a 0
    // bid → its value/PnL render as "—" and the sell floor refuses to sell. Seed
    // each position token's bid (and ask) from the data-api curPrice (the price
    // the position is marked at) so values render and the sell floor has a bid.
    // MERGE — never clobber the server-fed active-window values; only in wallet mode.
    // Re-read + guard: drop this write if the mode flipped or the active address
    // changed mid-flight (same stale-response protection as the balances patch).
    const st = useStore.getState()
    if (!stillCurrent()) return
    if (st.sign_mode === 'wallet') {
      const bids: Record<string, number> = { ...(st.token_bids ?? {}) }
      const asks: Record<string, number> = { ...(st.token_asks ?? {}) }
      for (const p of list) {
        const token = p.asset ?? ''
        const cents = Math.round((p.curPrice ?? 0) * 100)
        if (!token || !(cents > 0)) continue
        // Don't seed a bid for a resolved token — it isn't sellable on CLOB
        // (it routes to CLAIM); a pinned 100¢ would otherwise look like a live bid.
        if (positionResolution(p).resolved) continue
        // Don't override a live (server-fed) value already present for this token.
        if (!(bids[token] > 0)) bids[token] = cents
        if (!(asks[token] > 0)) asks[token] = cents
      }
      patch({ positions, token_bids: bids, token_asks: asks })
    } else {
      patch({ positions })
    }
  } catch { /* leave positions */ }
}
