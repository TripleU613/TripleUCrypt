import React, { useEffect, useRef, useState } from 'react'
import { animate } from 'animejs'
import { useStore, toast } from '../store.js'
import { call } from '../api.js'
import { C, FONT, D, SP, SZ, FS, FW, STR } from '../constants/index.js'
import { playFx } from '../lib/fx.js'
import { connectMetaMask, listWallets, subscribeWallets, onAddressChange, getWalletBalances, ensurePolygon,
  sendNativePol, sendErc20, sendTransaction, approveErc20, activeWalletId, forgetWallet, USDC_NATIVE, USDC_E } from '../buses/MetaMaskBus.js'
import { refreshBrowserPortfolio, resetClobCaches, warmClob } from '../buses/clobLazy.js'
// localStorage-only module: safe to import eagerly (ClobTrade's web3 deps stay lazy).
import { getPolyFunder, setPolyFunder, isAddressLike } from '../lib/polyFunder.js'

// Browser-mode swap: server builds the 0x quote (API key is server-side), the
// connected wallet approves (if needed) + signs the swap tx. Returns true on success.
async function execBrowserSwap(from: string, to: string, amount: number, taker: string): Promise<boolean> {
  let j: { ok?: boolean; error?: string; quote?: { to: string; data: string; value: string; sellToken: string; allowanceTarget: string | null } }
  try {
    const r = await fetch('/swap-quote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sell: from, buy: to, amount, taker }),
    })
    j = await r.json()
  } catch {
    toast('Swap quote failed (is the server running?)', 'error'); return false
  }
  if (!j.ok || !j.quote) { toast(j.error || 'Swap quote failed', 'error'); return false }
  const q = j.quote
  if (q.allowanceTarget && from !== 'POL') {
    toast('Approve the token in your wallet…', 'log')
    const a = await approveErc20(q.sellToken, q.allowanceTarget, taker)
    if (!a.ok) { toast(a.error || 'Approval rejected', 'error'); return false }
  }
  const s = await sendTransaction({ to: q.to, data: q.data, value: q.value }, taker)
  if (!s.ok) { toast(s.error || 'Swap failed', 'error'); return false }
  refreshWalletBalances(taker)
  return true
}

// Read the connected browser wallet's on-chain balances and push them into the
// store so the dashboard reflects what the wallet actually holds.
async function refreshWalletBalances(address: string): Promise<void> {
  const patch = useStore.getState()._patch
  if (!address) { patch({ mm_usdc: 0, mm_usdce: 0, mm_pol: 0 }); return }
  patch({ mm_bal_loading: true })
  try {
    const b = await getWalletBalances(address)
    patch({ mm_usdc: b.usdc, mm_usdce: b.usdce, mm_pol: b.pol })
  } finally {
    patch({ mm_bal_loading: false })
  }
}

interface WalletInfo { id: string; name: string; icon: string }

// Shared field styling — one subtle box level (sections themselves are border-free).
const INPUT_STYLE: React.CSSProperties = {
  width: '100%', background: 'transparent', border: 'none', color: C.WHITE,
  fontSize: FS.MD, fontFamily: FONT.MONO, padding: `${SP.MD} ${SP.LG}`, outline: 'none', boxSizing: 'border-box',
}
const FIELD_STYLE: React.CSSProperties = {
  display: 'flex', alignItems: 'center', width: '100%',
  background: 'var(--tc-card-alt)', border: '1px solid var(--tc-border)', borderRadius: '8px',
}

// ── Primitives ──────────────────────────────────────────────────────────────

function Spinner({ color = 'currentColor' }: { color?: string }) {
  return (
    <span style={{
      display: 'inline-block', width: SP.XL, height: SP.XL, borderRadius: '50%',
      border: `${SP.XXS} solid ${color}`, borderTopColor: 'transparent',
      animation: 'tc-spin 0.8s linear infinite', flexShrink: 0,
    }} />
  )
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontSize: FS.XXS, fontWeight: FW.XBOLD, letterSpacing: '0.14em',
      color: C.DIM3, fontFamily: FONT.MONO, textTransform: 'uppercase',
    }}>
      {children}
    </span>
  )
}

// Small info icon with a hover/tap tooltip — collapses inline explanations into
// an on-demand "ⓘ" by each section header.
function InfoTip({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <span
      style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onClick={() => setOpen(o => !o)}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={C.DIM3} strokeWidth="2.2"
        strokeLinecap="round" strokeLinejoin="round" style={{ cursor: 'help', display: 'block' }}>
        <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" /><line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
      {open && (
        <span style={{
          position: 'absolute', top: SP.H3, right: 0, zIndex: 60, width: '210px',
          padding: `${SP.MD} ${SP.LG}`, borderRadius: '8px',
          background: 'var(--tc-card-alt)', border: '1px solid var(--tc-border)',
          boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
          fontSize: FS.XXS, fontFamily: FONT.MONO, color: C.DIM, lineHeight: 1.55,
          fontWeight: FW.SEMI, textTransform: 'none', letterSpacing: 0, textAlign: 'left',
          pointerEvents: 'none',
        }}>{text}</span>
      )}
    </span>
  )
}

// A flat section: an uppercase title (+ optional info tooltip) and content, with
// a hairline divider below. No bordered box — keeps the panel from nesting boxes.
function Section({ title, tip, last = false, children }:
  { title: string; tip?: string; last?: boolean; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: D.GAP_MD, width: '100%',
      padding: `${SP.XXL} 0`,
      borderBottom: last ? 'none' : '1px solid var(--tc-border)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: SP.MD }}>
        <Label>{title}</Label>
        <div style={{ flex: 1 }} />
        {tip && <InfoTip text={tip} />}
      </div>
      {children}
    </div>
  )
}

// Amount-field trailing affordance: shows the available balance + a MAX toggle.
function MaxPill({ avail, isMax, onMax, unit = '' }:
  { avail: number; isMax: boolean; onMax: () => void; unit?: string }) {
  if (!(avail > 0)) return null
  const fmt = avail >= 1 ? avail.toFixed(2) : avail.toFixed(4)
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: SP.MD, flexShrink: 0, paddingRight: SP.SM }}>
      <span onClick={onMax} title={STR.WALLET_USE_ALL}
        style={{ cursor: 'pointer', fontSize: FS.NANO, fontWeight: FW.BOLD, fontFamily: FONT.MONO, color: C.DIM3, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
        {fmt}{unit ? ` ${unit}` : ''}
      </span>
      <div onClick={onMax} className="tc-hoverlift"
        onMouseEnter={e => playFx(e.currentTarget.querySelector('span'), 'pop')}
        style={{
          cursor: 'pointer', padding: `${SP.XS} ${SP.LG}`, borderRadius: '6px', boxSizing: 'border-box',
          background: isMax ? `rgba(245,158,11,0.18)` : 'transparent',
          border: `1px solid ${isMax ? C.GOLD : 'rgba(245,158,11,0.3)'}`,
          boxShadow: isMax ? `0 0 10px rgba(245,158,11,0.2)` : 'none',
          transition: 'background 0.12s, border-color 0.12s, box-shadow 0.12s',
        }}>
        <span style={{ display: 'inline-block', fontSize: FS.XXS, fontWeight: FW.XBOLD, fontFamily: FONT.MONO, color: C.GOLD, letterSpacing: '0.06em', opacity: isMax ? 1 : 0.8 }}>{STR.WALLET_MAX}</span>
      </div>
    </div>
  )
}

// accent = the single highlighted (green) action; default = quiet outline.
function Btn({ onClick, children, accent = false, busy = false }:
  { onClick: () => void; children: React.ReactNode; accent?: boolean; busy?: boolean }) {
  const fg = accent ? C.GREEN : C.DIM
  return (
    <div onClick={onClick} className="tc-hoverlift"
      onMouseEnter={e => playFx(e.currentTarget.querySelector('span'), 'pulse')}
      style={{
        cursor: 'pointer', width: '100%', padding: `${SP.LG} 0`, textAlign: 'center',
        borderRadius: D.R_BTN, display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: accent ? `rgba(${C.GREEN_RGB},0.08)` : 'transparent', boxSizing: 'border-box',
        border: `${accent ? 1.5 : 1}px solid ${accent ? C.GREEN : 'var(--tc-border)'}`,
        boxShadow: accent ? `0 0 12px rgba(${C.GREEN_RGB},0.16)` : 'none',
      }}>
      {busy
        ? <Spinner color={fg} />
        : <span style={{ display: 'inline-block', fontSize: FS.SM, fontWeight: FW.XBOLD, fontFamily: FONT.MONO, color: fg }}>{children}</span>}
    </div>
  )
}

function BalRow({ label, value, color = C.WHITE, strong = false }: { label: string; value: string; color?: string; strong?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', width: '100%' }}>
      <span style={{ fontSize: FS.XXS, fontWeight: FW.BOLD, letterSpacing: '0.06em', color: C.DIM3, fontFamily: FONT.MONO, textTransform: 'uppercase', flex: 1 }}>
        {label}
      </span>
      <span style={{ fontSize: strong ? FS.LG : FS.MD, fontWeight: strong ? FW.XBOLD : FW.BOLD, color, fontFamily: FONT.MONO, fontVariantNumeric: 'tabular-nums' }}>
        {value}
      </span>
    </div>
  )
}

function fmtUsd(n: number): string { return '$' + n.toFixed(2) }

function shortAddr(addr: string): string {
  return addr.length > 16 ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : addr
}

function CopyAddr({ addr, center = false }: { addr: string; center?: boolean }) {
  return (
    <div onClick={() => { navigator.clipboard.writeText(addr); toast('Address copied', 'log') }} className="tc-hoverlift" title={STR.WALLET_COPY}
      onMouseEnter={e => playFx(e.currentTarget.querySelector('svg'), 'pop')}
      style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: center ? 'center' : 'flex-start', gap: SP.SM }}>
      <span style={{ fontSize: FS.XS, fontFamily: FONT.MONO, color: C.DIM, fontVariantNumeric: 'tabular-nums' }}>{shortAddr(addr)}</span>
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={C.DIM3} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
    </div>
  )
}

// ── Supported wallet catalog (EIP-6963 rdns + install links) ──────────────────
interface CatalogWallet { id: string; name: string; chrome?: string; firefox?: string; home: string }
const WALLET_CATALOG: CatalogWallet[] = [
  { id: 'io.metamask', name: 'MetaMask', chrome: 'https://chromewebstore.google.com/detail/nkbihfbeogaeaoehlefnkodbefgpgknn', firefox: 'https://addons.mozilla.org/firefox/addon/ether-metamask/', home: 'https://metamask.io/download/' },
  { id: 'io.rabby', name: 'Rabby', chrome: 'https://chromewebstore.google.com/detail/acmacodkjbdgmoleebolmdjonilkdbch', home: 'https://rabby.io/' },
  { id: 'com.coinbase.wallet', name: 'Coinbase Wallet', chrome: 'https://chromewebstore.google.com/detail/hnfanknocfeofbddgcijnmhnfnkdnaad', home: 'https://www.coinbase.com/wallet/downloads' },
  { id: 'com.okex.wallet', name: 'OKX Wallet', chrome: 'https://chromewebstore.google.com/detail/mcohilncbfahbmgdjkbpemcciiolgcge', firefox: 'https://addons.mozilla.org/firefox/addon/okexwallet/', home: 'https://www.okx.com/web3' },
  { id: 'me.rainbow', name: 'Rainbow', chrome: 'https://chromewebstore.google.com/detail/opfgelmcmbiajamepnmloijbpoleiama', home: 'https://rainbow.me/extension' },
  { id: 'sh.frame', name: 'Frame', home: 'https://frame.sh/' },
]
const _isFirefox = typeof navigator !== 'undefined' && /firefox/i.test(navigator.userAgent)
function installUrl(w: CatalogWallet): string {
  return (_isFirefox && w.firefox) || w.chrome || w.home
}

// ── Balances ──────────────────────────────────────────────────────────────────

function BalancesSection() {
  const browser = useStore(s => s.sign_mode) === 'wallet'
  const mmAddress = useStore(s => s.mm_address)
  const statCash = useStore(s => s.stat_cash)
  // connected (browser) wallet — read client-side
  const mmUsdc = useStore(s => s.mm_usdc)
  const mmUsdce = useStore(s => s.mm_usdce)
  const mmPol = useStore(s => s.mm_pol)
  // env wallet — read server-side
  const wNative = useStore(s => s.wallet_native_usdc)
  const wUsdcE = useStore(s => s.wallet_usdc_e)

  const tip = "Balances of the wallet that's trading (set in Wallet Mode). USDC is spendable cash; USDC.e is what Polymarket trades; Gas (POL) pays network fees; 'On Polymarket' is collateral already on the exchange."

  // No balance source (browser mode, nothing connected) → hide the section.
  if (browser && !mmAddress) return null

  const usdc = browser ? mmUsdc : wNative
  const usdce = browser ? mmUsdce : wUsdcE
  const pol = browser ? mmPol : null // env wallet POL isn't tracked
  const z = (n: number) => (n > 0 ? C.WHITE : C.DIM3)

  return (
    <Section title={STR.WALLET_SEC_BAL} tip={tip}>
      <BalRow label="USDC" value={fmtUsd(usdc)} color={usdc > 0 ? C.GREEN : C.DIM3} strong />
      <BalRow label="USDC.e" value={fmtUsd(usdce)} color={z(usdce)} />
      <BalRow label={STR.WALLET_ON_POLY} value={fmtUsd(statCash)} color={z(statCash)} />
      <BalRow label={STR.WALLET_GAS_BAL} value={pol == null ? '—' : `${pol.toFixed(4)} POL`} color={pol == null ? C.DIM3 : pol > 0 ? C.DIM : C.RED} />
    </Section>
  )
}

// ── Swap + auto-gas ───────────────────────────────────────────────────────────

const SWAP_TOKENS = ['USDC', 'USDC.e', 'POL']

function SwapSection() {
  const browser = useStore(s => s.sign_mode) === 'wallet'
  const practice = useStore(s => s.practice)
  const swapFrom = useStore(s => s.swap_from)
  const swapTo = useStore(s => s.swap_to)
  const swapAmount = useStore(s => s.swap_amount)
  const swapBusy = useStore(s => s.swap_busy)
  const swapStatus = useStore(s => s.swap_status)
  const gasBusy = useStore(s => s.gas_busy)
  const gasStatus = useStore(s => s.gas_status)
  const mmAddress = useStore(s => s.mm_address)
  const mmUsdc = useStore(s => s.mm_usdc)
  const mmUsdce = useStore(s => s.mm_usdce)
  const mmPol = useStore(s => s.mm_pol)
  const wNative = useStore(s => s.wallet_native_usdc)
  const wUsdcE = useStore(s => s.wallet_usdc_e)
  const patch = useStore(s => s._patch)

  if (practice) return null

  // Balance of each token on the active wallet (env POL isn't tracked → 0/unknown).
  const balOf = (t: string): number =>
    t === 'USDC' ? (browser ? mmUsdc : wNative)
    : t === 'USDC.e' ? (browser ? mmUsdce : wUsdcE)
    : (browser ? mmPol : 0)

  const fromAvail = balOf(swapFrom)
  const isMax = swapAmount !== '' && fromAvail > 0 && parseFloat(swapAmount) === fromAvail

  const setAmt = (v: string) => { const c = v.replace(/[^0-9.]/g, ''); patch({ swap_amount: c }); call('set_swap_amount', c) }
  const doMax = () => { const v = isMax ? '' : String(fromAvail); patch({ swap_amount: v }); call('set_swap_amount', v) }
  const pickFrom = (t: string) => { patch({ swap_from: t }); call('set_swap_from', t) }
  const pickTo = (t: string) => { patch({ swap_to: t }); call('set_swap_to', t) }

  // Browser mode runs the swap through the connected wallet; Server mode uses the .env key.
  const onSwap = async () => {
    if (!browser) { call('swap'); return }
    const amt = parseFloat(swapAmount)
    if (!(amt > 0)) { toast('Enter an amount', 'error'); return }
    if (swapFrom === swapTo) { toast('Pick two different tokens', 'error'); return }
    patch({ swap_busy: true })
    try {
      const ok = await execBrowserSwap(swapFrom, swapTo, amt, mmAddress)
      if (ok) { toast(`Swapped ${amt} ${swapFrom} → ${swapTo}`, 'log'); patch({ swap_amount: '' }) }
    } finally { patch({ swap_busy: false }) }
  }
  const onGetGas = async () => {
    if (!browser) { call('get_gas'); return }
    const tok = mmUsdce > 0 ? 'USDC.e' : 'USDC'
    const bal = tok === 'USDC.e' ? mmUsdce : mmUsdc
    if (!(bal > 0)) { toast('No USDC to swap for gas', 'error'); return }
    patch({ gas_busy: true })
    try {
      const ok = await execBrowserSwap(tok, 'POL', Math.min(0.5, bal), mmAddress)
      if (ok) toast('Swapped for POL gas', 'log')
    } finally { patch({ gas_busy: false }) }
  }

  // Each token pill shows its balance underneath, so you always see what you
  // have and what you don't (zeros render dim).
  const tokenPills = (sel: string, onPick: (t: string) => void) => (
    <div style={{ display: 'flex', gap: SP.XS, flex: 1 }}>
      {SWAP_TOKENS.map(t => {
        const b = balOf(t)
        const on = t === sel
        return (
          <div key={t} onClick={() => onPick(t)} className="tc-hoverlift"
            style={{
              flex: 1, cursor: 'pointer', textAlign: 'center', padding: `${SP.SM} 0`, borderRadius: '6px',
              border: `1px solid ${on ? C.GOLD : 'var(--tc-border)'}`,
              background: on ? 'rgba(245,158,11,0.08)' : 'transparent',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: SP.XXS,
            }}>
            <span style={{ color: on ? C.GOLD : C.DIM3, fontFamily: FONT.MONO, fontSize: FS.XXS, fontWeight: FW.XBOLD }}>{t}</span>
            <span style={{ color: b > 0 ? C.DIM : C.DIM3, fontFamily: FONT.MONO, fontSize: FS.MICRO, fontWeight: FW.BOLD, fontVariantNumeric: 'tabular-nums', opacity: b > 0 ? 1 : 0.5 }}>
              {t === 'POL' ? b.toFixed(3) : b.toFixed(2)}
            </span>
          </div>
        )
      })}
    </div>
  )

  const rowLabel = (t: string) => (
    <span style={{ width: '38px', flexShrink: 0, fontSize: FS.NANO, fontFamily: FONT.MONO, color: C.DIM3, letterSpacing: '0.06em' }}>{t}</span>
  )

  return (
    <Section title={STR.WALLET_SEC_SWAP} tip="Convert tokens on the active wallet — native USDC → USDC.e (what Polymarket trades) or → POL (gas). Each token shows its balance. 'Get gas' tops up POL by swapping a little USDC.e.">
      {/* Primary quick action: top up gas */}
      <Btn accent busy={gasBusy} onClick={onGetGas}>{STR.WALLET_GET_GAS}</Btn>
      {gasStatus && <span style={{ fontSize: FS.XXS, fontFamily: FONT.MONO, color: C.DIM3, textAlign: 'center' }}>{gasStatus}</span>}

      <div style={{ height: SP.HAIR, width: '100%', background: 'var(--tc-border)' }} />

      {/* Manual swap */}
      <div style={{ display: 'flex', alignItems: 'center', gap: SP.MD }}>{rowLabel('FROM')}{tokenPills(swapFrom, pickFrom)}</div>
      <div style={{ display: 'flex', alignItems: 'center', gap: SP.MD }}>{rowLabel('TO')}{tokenPills(swapTo, pickTo)}</div>
      <div style={FIELD_STYLE}>
        <input placeholder="0.00" value={swapAmount} inputMode="decimal" onChange={e => setAmt(e.target.value)} style={INPUT_STYLE} />
        <MaxPill avail={fromAvail} isMax={isMax} onMax={doMax} unit={swapFrom} />
      </div>
      <Btn busy={swapBusy} onClick={onSwap}>Swap {swapFrom} → {swapTo}</Btn>
      {swapStatus && <span style={{ fontSize: FS.XXS, fontFamily: FONT.MONO, color: C.DIM3, textAlign: 'center' }}>{swapStatus}</span>}
    </Section>
  )
}

// ── Send ────────────────────────────────────────────────────────────────────

const SEND_CURRENCIES = ['USDC', 'USDC.e', 'POL', 'ETH', 'WETH', 'WBTC']
// MAX of native POL must leave a little behind to pay the gas of the send itself.
const POL_GAS_RESERVE = 0.01
const COIN_FILE: Record<string, string> = {
  'USDC': 'usdc', 'USDC.e': 'usdc', 'POL': 'pol', 'ETH': 'eth', 'WETH': 'eth', 'WBTC': 'wbtc',
}

function CoinLogo({ cur, size = 18 }: { cur: string; size?: number }) {
  const file = COIN_FILE[cur] ?? 'usdc'
  return <img src={`/coins/${file}.svg`} alt={cur} width={size} height={size} draggable={false}
    style={{ width: size, height: size, flexShrink: 0, display: 'block', borderRadius: '50%' }} />
}

function CarouselArrow({ dir, onClick }: { dir: 'l' | 'r'; onClick: () => void }) {
  return (
    <div onClick={onClick} onMouseEnter={e => playFx(e.currentTarget, 'roll')}
      style={{ cursor: 'pointer', width: SZ.S24, height: SZ.S34, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '6px', color: C.DIM3, fontSize: FS.H3, fontWeight: FW.BOLD, userSelect: 'none' }}>
      {dir === 'l' ? '‹' : '›'}
    </div>
  )
}

function SendSection() {
  const browser = useStore(s => s.sign_mode) === 'wallet'
  const sendAmount = useStore(s => s.send_amount)
  const sendTo = useStore(s => s.send_to)
  const sendCurrency = useStore(s => s.send_currency)
  const sendBusy = useStore(s => s.send_busy)
  const mmUsdc = useStore(s => s.mm_usdc)
  const mmUsdce = useStore(s => s.mm_usdce)
  const mmPol = useStore(s => s.mm_pol)
  const wNative = useStore(s => s.wallet_native_usdc)
  const wUsdcE = useStore(s => s.wallet_usdc_e)
  const patch = useStore(s => s._patch)

  const n = SEND_CURRENCIES.length
  const idx = Math.max(0, SEND_CURRENCIES.indexOf(sendCurrency))
  const prev = SEND_CURRENCIES[(idx - 1 + n) % n]
  const next = SEND_CURRENCIES[(idx + 1) % n]
  const cycle = (d: number) => call('set_send_currency', SEND_CURRENCIES[(idx + d + n) % n])

  // Available balance of the selected token on the active wallet (untracked → 0).
  const avail = sendCurrency === 'USDC' ? (browser ? mmUsdc : wNative)
    : sendCurrency === 'USDC.e' ? (browser ? mmUsdce : wUsdcE)
    : sendCurrency === 'POL' ? (browser ? mmPol : 0)
    : 0
  // MAX amount: native POL keeps a small gas buffer; ERC-20s can send the full balance (gas is paid in POL).
  const maxAmount = sendCurrency === 'POL' ? Math.max(0, avail - POL_GAS_RESERVE) : avail
  const isMax = sendAmount !== '' && maxAmount > 0 && Math.abs(parseFloat(sendAmount) - maxAmount) < 1e-9

  const mmAddress = useStore(s => s.mm_address)
  const setAmt = (v: string) => { const c = v.replace(/[^0-9.]/g, ''); patch({ send_amount: c, send_status: '' }); call('set_send_amount', c) }
  const setTo = (v: string) => { patch({ send_to: v, send_status: '' }); call('set_send_to', v) }
  const doMax = () => { const v = isMax ? '' : String(maxAmount); patch({ send_amount: v, send_status: '' }); call('set_send_amount', v) }

  // Browser mode → the connected wallet sends directly (no server key involved).
  // Server mode → the existing server-side send.
  const TOKEN_ADDR: Record<string, string> = { 'USDC': USDC_NATIVE, 'USDC.e': USDC_E }
  const browserSend = async () => {
    const to = (sendTo ?? '').trim()
    const amount = parseFloat(sendAmount)
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) { toast('Invalid address', 'error'); return }
    if (!(amount > 0)) { toast('Enter an amount', 'error'); return }
    if (amount > avail + 1e-9) { toast(`Max ${avail} ${sendCurrency}`, 'error'); return }
    patch({ send_busy: true })
    try {
      let r
      if (sendCurrency === 'POL') r = await sendNativePol(to, amount, mmAddress)
      else if (TOKEN_ADDR[sendCurrency]) r = await sendErc20(TOKEN_ADDR[sendCurrency], to, amount, mmAddress)
      else { toast(`${sendCurrency} send isn't supported from a browser wallet yet`, 'error'); return }
      if (r.ok) { toast(`Sent ${amount} ${sendCurrency}`, 'log'); patch({ send_amount: '', send_to: '' }); refreshWalletBalances(mmAddress) }
      else toast(r.error || 'Send failed', 'error')
    } finally { patch({ send_busy: false }) }
  }
  const onSend = () => (browser ? browserSend() : call('send_now'))

  const sideCur = (cur: string, onClick: () => void) => (
    <div onClick={onClick} onMouseEnter={e => playFx(e.currentTarget.querySelector('img'), 'jiggle')} style={{ cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center', opacity: 0.35 }} title={cur}>
      <CoinLogo cur={cur} size={18} />
    </div>
  )

  return (
    <Section title={STR.WALLET_SEC_SEND} last tip="Withdraw funds from the active wallet to any address. Pick the token, enter an amount (MAX sends everything), paste the destination, and Send. Costs a little POL for gas.">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SP.XL, width: '100%', padding: `${SP.XXS} 0` }}>
        <CarouselArrow dir="l" onClick={() => cycle(-1)} />
        {sideCur(prev, () => cycle(-1))}
        <div onMouseEnter={e => playFx(e.currentTarget.querySelector('img'), 'jiggle')} style={{ display: 'flex', alignItems: 'center', gap: SP.MD, minWidth: '96px', justifyContent: 'center' }}>
          <CoinLogo cur={sendCurrency} size={24} />
          <span style={{ fontSize: FS.LG, fontWeight: FW.XBOLD, fontFamily: FONT.MONO, color: C.WHITE, letterSpacing: '0.02em' }}>{sendCurrency}</span>
        </div>
        {sideCur(next, () => cycle(1))}
        <CarouselArrow dir="r" onClick={() => cycle(1)} />
      </div>
      <div style={FIELD_STYLE}>
        <span style={{ paddingLeft: SP.LG, fontSize: FS.MD, fontFamily: FONT.MONO, color: sendAmount ? C.WHITE : C.DIM3, flexShrink: 0 }}>$</span>
        <input placeholder="0.00" value={sendAmount} inputMode="decimal" onChange={e => setAmt(e.target.value)} style={{ ...INPUT_STYLE, paddingLeft: SP.XXS }} />
        <MaxPill avail={avail} isMax={isMax} onMax={doMax} unit={sendCurrency} />
      </div>
      <div style={FIELD_STYLE}>
        <input placeholder="Recipient  0x…" value={sendTo} onChange={e => setTo(e.target.value)} style={INPUT_STYLE} />
      </div>
      <Btn accent onClick={onSend} busy={sendBusy}>Send {sendCurrency}</Btn>
    </Section>
  )
}

// ── Wallet Mode (who signs) ───────────────────────────────────────────────────

function WalletModeSection() {
  const signMode = useStore(s => s.sign_mode)
  const mmAddress = useStore(s => s.mm_address)
  const mmStatus = useStore(s => s.mm_status)
  const patch = useStore(s => s._patch)
  const [wallets, setWallets] = useState<WalletInfo[]>(() => listWallets())

  useEffect(() => {
    const unsub = onAddressChange(addr => {
      // Account switch / disconnect: drop the address-bound ClobClient/approval
      // caches so the new (or no) account never reuses the old account's signer,
      // creds, or approval state (wrong-account signing).
      resetClobCaches()
      if (!addr) { patch({ mm_address: '', mm_status: '', mm_usdc: 0, mm_usdce: 0, mm_pol: 0 }); call('disconnect_metamask') }
      else { patch({ mm_address: addr }); call('on_mm_connect', addr, '0x89', true); refreshWalletBalances(addr) } // silent — accountsChanged fires on load too
    })
    const unsubW = subscribeWallets(() => setWallets(listWallets()))
    return () => { unsub(); unsubW() }
  }, [patch])

  const disconnect = () => {
    forgetWallet()
    patch({ mm_address: '', mm_status: '', mm_usdc: 0, mm_usdce: 0, mm_pol: 0 })
    call('disconnect_metamask')
  }

  async function connectInjected(id?: string) {
    patch({ mm_status: 'Connecting…' })
    const res = await connectMetaMask(id)
    if (res.ok) {
      patch({ mm_address: res.address, mm_status: '' })
      const onPolygon = res.chainId === '0x89' || res.chainId === '137'
      if (!onPolygon) await ensurePolygon() // auto-switch instead of nagging
      call('on_mm_connect', res.address, '0x89') // sync server so a refresh/reconnect keeps us connected
      await refreshBrowserPortfolio(res.address)
      // NO transactions on connect — approvals happen only when you click
      // "Enable trading" (or your first trade), once.
    } else {
      patch({ mm_address: '', mm_status: '' })
      toast(res.error || 'Wallet connection failed', 'error')
    }
  }

  const isWallet = signMode === 'wallet'
  const segRef = useRef<HTMLDivElement>(null)
  const indRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef(true)
  useEffect(() => {
    const box = segRef.current, ind = indRef.current
    if (!box || !ind) return
    const seg = box.querySelector(`[data-sign="${isWallet ? 'wallet' : 'instant'}"]`) as HTMLElement | null
    if (!seg) return
    const left = seg.offsetLeft, w = seg.offsetWidth
    if (firstRef.current) {
      ind.style.left = `${left}px`; ind.style.width = `${w}px`; ind.style.opacity = '1'
      firstRef.current = false
      return
    }
    animate(ind, { left: `${left}px`, width: `${w}px`, duration: 320, ease: 'out(3)' })
  }, [isWallet])

  const seg = (): React.CSSProperties => ({
    flex: 1, cursor: 'pointer', padding: `${SP.SM} 0`, textAlign: 'center', borderRadius: '6px',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: SP.SM,
    position: 'relative', zIndex: 1, background: 'transparent', border: '1px solid transparent',
    boxSizing: 'border-box', transition: 'all 0.12s',
  })
  const segTxt = (active: boolean): React.CSSProperties => ({
    fontSize: FS.XS, fontWeight: FW.XBOLD, fontFamily: FONT.MONO, color: active ? C.GOLD : C.DIM3,
  })
  const pick: React.CSSProperties = {
    cursor: 'pointer', width: '100%', padding: `${SP.MD} ${SP.XL}`, borderRadius: D.R_BTN,
    border: '1px solid var(--tc-border)', background: 'var(--tc-card-alt)',
    display: 'flex', alignItems: 'center', gap: SP.MD,
  }
  const pickTxt: React.CSSProperties = { fontSize: FS.SM, fontWeight: FW.XBOLD, fontFamily: FONT.MONO, color: C.WHITE }

  return (
    <Section title={STR.WALLET_SEC_MODE} tip="Which wallet trades. Server Wallet uses the .env key — instant, no popups. Browser Wallet trades from your connected extension (e.g. MetaMask), signing each order with a popup; it must be on the Polygon network.">
      <div ref={segRef} style={{ position: 'relative', display: 'flex', gap: SP.XXS, background: 'var(--tc-card-alt)', borderRadius: '8px', padding: SP.XXS, border: '1px solid var(--tc-border)' }}>
        <div ref={indRef} style={{
          position: 'absolute', top: SP.XXS, bottom: SP.XXS, left: 0, width: 0, opacity: 0,
          border: `1px solid ${C.GOLD}`, borderRadius: '6px', boxShadow: `0 0 10px rgba(245,158,11,0.27)`,
          pointerEvents: 'none', boxSizing: 'border-box', zIndex: 0,
        }} />
        <div data-sign="instant" style={seg()} onMouseEnter={e => playFx(e.currentTarget.querySelector('svg'), 'jiggle')} onClick={() => call('set_sign_mode', 'instant')}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={!isWallet ? C.GOLD : C.DIM3} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m21 2-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4" /></svg>
          <span style={segTxt(!isWallet)}>{STR.WALLET_MODE_SERVER}</span>
        </div>
        <div data-sign="wallet" style={seg()} onMouseEnter={e => playFx(e.currentTarget.querySelector('svg'), 'jiggle')} onClick={() => call('set_sign_mode', 'wallet')}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={isWallet ? C.GOLD : C.DIM3} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><polyline points="9 12 11 14 15 10" /></svg>
          <span style={segTxt(isWallet)}>{STR.WALLET_MODE_BROWSER}</span>
        </div>
      </div>

      {isWallet && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: D.GAP_SM, width: '100%' }}>
          {(() => {
            const detected = new Map(wallets.map(w => [w.id, w]))
            const inCatalog = new Set(WALLET_CATALOG.map(c => c.id))
            const rows = [
              ...WALLET_CATALOG.map(c => ({ cat: c, det: detected.get(c.id) })),
              ...wallets.filter(w => !inCatalog.has(w.id)).map(w => ({ cat: undefined as CatalogWallet | undefined, det: w })),
            ]
            const activeId = activeWalletId()
            return rows.map(({ cat, det }) => {
              const installed = !!det
              const id = det?.id ?? cat!.id
              const name = det?.name ?? cat!.name
              const connectedHere = !!mmAddress && id === activeId
              return (
                <div key={id} className="tc-hoverlift"
                  style={{ ...pick, opacity: installed ? 1 : 0.62, borderColor: connectedHere ? C.GOLD : 'var(--tc-border)' }}
                  onMouseEnter={e => playFx(e.currentTarget.querySelector('img, svg'), 'jiggle')}
                  onClick={() => connectedHere ? disconnect() : installed ? connectInjected(id) : window.open(installUrl(cat!), '_blank', 'noopener')}>
                  {/* EIP-6963 requires this icon to be a data: URI, but that is the
                      extension's promise, not something we can rely on. A remote
                      https icon from a non-conforming wallet would be a direct
                      third-party request from the browser, which this app does not
                      make anywhere else — so render it only when it really is inline,
                      and fall back to the generic shield otherwise. */}
                  {det?.icon && det.icon.startsWith('data:')
                    ? <img src={det.icon} alt="" width={18} height={18} style={{ borderRadius: '4px', flexShrink: 0 }} />
                    : <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.DIM3} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /></svg>}
                  <span style={pickTxt}>{name}</span>
                  <div style={{ flex: 1 }} />
                  {connectedHere
                    ? <span style={{ fontSize: FS.NANO, fontWeight: FW.XBOLD, fontFamily: FONT.MONO, color: C.RED, letterSpacing: '0.06em' }}>{STR.WALLET_REMOVE}</span>
                    : installed
                      ? <span style={{ fontSize: FS.NANO, fontWeight: FW.BOLD, fontFamily: FONT.MONO, color: C.GREEN, letterSpacing: '0.05em' }}>{STR.WALLET_DETECTED}</span>
                      : <span style={{ display: 'flex', alignItems: 'center', gap: SP.XXS, fontSize: FS.NANO, fontWeight: FW.BOLD, fontFamily: FONT.MONO, color: C.DIM3 }}>
                          {STR.WALLET_INSTALL}
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={C.DIM3} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M7 7h10v10" /></svg>
                        </span>}
                </div>
              )
            })
          })()}
        </div>
      )}
      {mmStatus && !mmAddress && <span style={{ fontSize: FS.XXS, fontFamily: FONT.MONO, color: C.DIM3, textAlign: 'center' }}>{mmStatus}</span>}

      {/* Polymarket wallet (Safe proxy) address -- required for browser trading */}
      {isWallet && mmAddress && <PolyFunderField signer={mmAddress} />}
    </Section>
  )
}


/**
 * The Polymarket wallet (Gnosis Safe proxy) address to trade as.
 *
 * When you connect MetaMask to Polymarket, it creates a Safe PROXY that holds your
 * collateral; that proxy -- not your EOA -- is the allowed maker. Signing as the
 * bare EOA gets the order rejected with "maker address not allowed. please use the
 * deposit market flow". There is no public endpoint that resolves an EOA to its
 * proxy (the server path takes POLY_WALLET_ADDRESS as config for the same reason),
 * so it is entered here and kept in localStorage per browser.
 *
 * Leave it EMPTY to trade as a bare EOA (signature type 0) -- correct only for a
 * wallet that has itself been onboarded and approved on-chain.
 */
function PolyFunderField({ signer }: { signer: string }) {
  const [val, setVal] = useState(() => getPolyFunder())
  const [saved, setSaved] = useState(false)
  const valid = val === '' || isAddressLike(val)
  const isEoa = val.trim().toLowerCase() === signer.toLowerCase()

  const commit = () => {
    if (!valid) return
    setPolyFunder(val.trim())
    resetClobCaches()   // maker changed: drop the cached client + derived L2 creds
    setSaved(true)
    setTimeout(() => setSaved(false), 1500)
    // Balances/positions are read from the maker, so re-read for the new account.
    refreshBrowserPortfolio(signer).catch(() => {})
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP.XS, width: '100%' }}>
      <span style={{ fontSize: FS.NANO, fontWeight: FW.XBOLD, letterSpacing: '0.06em', color: 'var(--tc-dim2)', fontFamily: FONT.MONO }}>
        {STR.POLY_FUNDER_LABEL}
      </span>
      <div style={{ display: 'flex', gap: SP.XS, width: '100%' }}>
        <input
          value={val}
          onChange={e => { setVal(e.target.value); setSaved(false) }}
          onBlur={commit}
          onKeyDown={e => { if (e.key === 'Enter') commit() }}
          placeholder="0x… (Polymarket → Deposit)"
          spellCheck={false}
          autoComplete="off"
          style={{
            flex: 1, minWidth: 0, padding: `${SP.SM} ${SP.MD}`, borderRadius: D.R_BTN,
            border: `1px solid ${valid ? 'var(--tc-border)' : C.RED}`,
            background: 'var(--tc-card-alt)', color: 'var(--tc-text-strong)',
            fontSize: FS.XS, fontFamily: FONT.MONO, outline: 'none',
          }}
        />
        <button
          onClick={commit}
          disabled={!valid}
          style={{
            flexShrink: 0, padding: `${SP.SM} ${SP.LG}`, borderRadius: D.R_BTN,
            border: `1px solid ${valid ? C.GREEN_BORDER : 'var(--tc-border)'}`,
            background: 'transparent', color: valid ? C.GREEN : C.DIM3,
            fontSize: FS.XS, fontWeight: FW.XBOLD, fontFamily: FONT.MONO,
            cursor: valid ? 'pointer' : 'default',
          }}
        >{saved ? STR.POLY_FUNDER_SAVED : STR.POLY_FUNDER_SAVE}</button>
      </div>
      <span style={{ fontSize: FS.NANO, fontFamily: FONT.MONO, color: !valid ? C.RED : isEoa ? C.GOLD : 'var(--tc-dim3)', lineHeight: 1.4 }}>
        {!valid ? STR.POLY_FUNDER_BAD : isEoa ? STR.POLY_FUNDER_IS_EOA : val ? STR.POLY_FUNDER_OK : STR.POLY_FUNDER_HINT}
      </span>
    </div>
  )
}

// ── WalletPanel ───────────────────────────────────────────────────────────────

function WalletPanelInner({ onClose }: { onClose?: () => void }) {
  // Opening the wallet is a strong signal the signing chunk is about to be
  // needed; start fetching it now rather than on the first click.
  useEffect(() => { warmClob() }, [])

  const mmAddress = useStore(s => s.mm_address)
  const walletAddress = useStore(s => s.wallet_address)
  const depositAddr = mmAddress || walletAddress
  const walletLoading = useStore(s => s.wallet_loading)
  const mmBalLoading = useStore(s => s.mm_bal_loading)
  const browserMode = useStore(s => s.sign_mode) === 'wallet'
  const connected = !!mmAddress

  // While a browser wallet is connected, poll its on-chain balances.
  useEffect(() => {
    if (!mmAddress) return
    // In Browser mode the connected wallet owns balances + positions + the top bar,
    // so pull the full portfolio; otherwise just the panel's on-chain balances.
    const pull = () => browserMode ? refreshBrowserPortfolio(mmAddress) : refreshWalletBalances(mmAddress)
    pull()
    const id = setInterval(pull, 15000)
    return () => clearInterval(id)
  }, [mmAddress, browserMode])

  const iconBtn: React.CSSProperties = {
    cursor: 'pointer', padding: SP.XS, borderRadius: '7px', border: '1px solid var(--tc-border)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  }

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: SP.NONE,
      width: '100%', padding: `0 ${D.PAD_MD}`, background: 'var(--tc-card)', overflowY: 'auto',
    }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', width: '100%', gap: SP.MD, padding: `${SP.XXL} 0`, borderBottom: '1px solid var(--tc-border)' }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.GREEN} strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4" /><path d="M4 6v12c0 1.1.9 2 2 2h14v-4" /><path d="M18 12a2 2 0 0 0 0 4h4v-4z" /></svg>
        <div style={{ display: 'flex', flexDirection: 'column', gap: SP.XXS, minWidth: 0, justifyContent: 'center' }}>
          <span style={{ fontWeight: FW.XBOLD, fontSize: FS.LG, fontFamily: FONT.MONO, color: C.WHITE, lineHeight: 1 }}>{STR.WALLET_TITLE}</span>
          {depositAddr && <CopyAddr addr={depositAddr} />}
        </div>
        <div style={{ flex: 1 }} />
        <div onClick={() => { call('refresh_wallet'); if (connected) refreshWalletBalances(mmAddress) }} className="tc-hoverlift" title={STR.WALLET_REFRESH}
          onMouseEnter={e => playFx(e.currentTarget.querySelector('svg'), 'spin')} style={{ ...iconBtn, marginRight: D.GAP_SM }}>
          {(walletLoading || mmBalLoading)
            ? <Spinner color={C.DIM3} />
            : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={C.DIM3} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M23 4v6h-6" /><path d="M1 20v-6h6" /><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" /></svg>}
        </div>
        <div onClick={() => (onClose ? onClose() : call('close_wallet'))} className="tc-hoverlift"
          onMouseEnter={e => playFx(e.currentTarget.querySelector('svg'), 'shake')} style={iconBtn}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={C.DIM3} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" /></svg>
        </div>
      </div>

      <WalletModeSection />
      <BalancesSection />
      <SwapSection />
      <SendSection />
    </div>
  )
}

// Memoised: App is the root and re-renders on theme/mode/wallet changes.
// These panels take no props (or one stable one) and read what they need from
// the store themselves, so a parent re-render should never cascade into them.
export const WalletPanel = React.memo(WalletPanelInner)
