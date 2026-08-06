/**
 * Global activity feed — the server-side source for the scrolling activity log.
 *
 * The browser used to subscribe to the Polymarket RTDS firehose directly and
 * build this log itself. The server already receives every one of those events
 * (RTDS activity/comments on the social socket, Chainlink price ticks on the
 * chart socket), so it builds the log here instead and ships it in state; the
 * browser then talks to nothing but this app's own origin.
 *
 * Deliberately UNFILTERED by market: this is the "everything happening on
 * Polymarket right now" log, unlike state.mkt_trades which is scoped to the
 * viewed market. Both are fed from the same RTDS messages (see social.ts).
 */
import { state, patch } from './state.js'
import type { AppState } from './state.js'
import { bus } from '../bus.js'

// ── Entry shape ───────────────────────────────────────────────────────────────

export interface ActivityEntry {
  /** Monotonic id — a stable React key, and the merge/ordering handle. */
  id: number
  /** "HH:MM:SS" UTC. Pre-formatted here because every client renders it as-is. */
  t: string
  kind: 'price' | 'trade' | 'chat'
  /** Fully formatted row text — the client needs no lookups to render it. */
  text: string
  /** Trade direction, for the green/red tint. Absent on price/chat rows. */
  up?: boolean
}

// The whole array ships in every SSE snapshot AND in every flush patch, so this
// cap is a bandwidth knob, not only a memory one — the same reason ORDERS_MAX
// exists in trading.ts. 60 rows is more than the log shows at once, and the
// client accumulates its own longer scrollback from the arriving patches.
const ACTIVITY_MAX = 60

// Coalescing window. Patching per message would be one SSE frame and one React
// commit per trade — hundreds per second on a busy window. 300ms is under the
// threshold at which a scrolling log stops looking live, while cutting the frame
// rate to ~3/s. A burst that fills FLUSH_AT flushes early, so we never trade
// latency for a bigger batch during exactly the moments that matter.
const FLUSH_MS = 300
const FLUSH_AT = 24

// A chatty asset can emit several oracle ticks a second. Unthrottled, price rows
// would evict every trade and comment from a 60-row window, which is the
// opposite of what this log is for.
const PRICE_MIN_GAP_MS = 500

// ── Buffer + flush ────────────────────────────────────────────────────────────

let _id = 0
let _buf: ActivityEntry[] = []
let _timer: ReturnType<typeof setTimeout> | null = null
const _lastPriceAt = new Map<string, number>()

export function initState(s: AppState): void {
  s.activity = []
}

/** Wire the sources that arrive on the internal bus rather than through
 *  social.ts's socket. Chainlink ticks come from chart.ts's own RTDS socket, so
 *  we reuse the tick it already emits instead of opening a second subscription. */
export function startActivityFeed(): void {
  bus.on('chainlink_tick', (asset: string, price: number) => {
    const now = Date.now()
    const last = _lastPriceAt.get(asset) ?? 0
    if (now - last < PRICE_MIN_GAP_MS) return
    _lastPriceAt.set(asset, now)
    push({ kind: 'price', text: `${asset.toUpperCase()} $${_money(price)}` })
  })
}

function push(e: { kind: ActivityEntry['kind']; text: string; up?: boolean }): void {
  if (!e.text) return
  const entry: ActivityEntry = { id: ++_id, t: _clock(), kind: e.kind, text: e.text }
  if (e.up !== undefined) entry.up = e.up
  _buf.push(entry)

  if (_buf.length >= FLUSH_AT) { flush(); return }
  if (!_timer) {
    _timer = setTimeout(flush, FLUSH_MS)
    // Never hold the process open for a log flush.
    _timer.unref?.()
  }
}

function flush(): void {
  if (_timer) { clearTimeout(_timer); _timer = null }
  if (!_buf.length) return
  // Newest first: the buffer is oldest-first, so reverse this batch onto the head.
  const batch = _buf.reverse()
  _buf = []
  patch('activity', [...batch, ...(state.activity ?? [])].slice(0, ACTIVITY_MAX))
}

// ── RTDS frame ingestion ──────────────────────────────────────────────────────

/**
 * Feed one raw RTDS frame into the activity log. Called for EVERY frame, before
 * social.ts applies its per-market condition_id filter — that filter is what
 * makes state.mkt_trades single-market, and this log must not inherit it.
 *
 * Tolerates malformed frames by ignoring them; the caller cannot afford a throw.
 */
export function ingestRtdsFrame(frame: unknown): void {
  if (typeof frame !== 'object' || frame === null) return
  const m = frame as Record<string, unknown>
  const topic = typeof m['topic'] === 'string' ? m['topic'] : ''
  const p = (typeof m['payload'] === 'object' && m['payload'] !== null
    ? m['payload'] as Record<string, unknown>
    : m)

  // Chainlink price frames also reach the chart socket, where they become
  // 'chainlink_tick' — ignore them here so a shared subscription can't double up.
  if (topic === 'crypto_prices_chainlink') return

  if (p['side'] || p['outcome']) {
    const up = String(p['outcome'] ?? '').toLowerCase() === 'up'
    const amt = (parseFloat(String(p['size'] ?? 0)) * parseFloat(String(p['price'] ?? 0))) || 0
    const verb = String(p['side'] ?? '').toUpperCase() === 'SELL' ? 'sold' : 'bought'
    push({ kind: 'trade', up, text: `${_who(p)} ${verb} ${up ? 'Up' : 'Down'} $${_money(amt)}` })
    return
  }

  const prof = (typeof p['profile'] === 'object' && p['profile'] !== null
    ? p['profile'] as Record<string, unknown>
    : p)
  if (p['body'] || (prof['name'] && topic === 'comments')) {
    const who = String(prof['name'] ?? prof['pseudonym'] ?? 'anon')
    push({ kind: 'chat', text: `${who}: ${String(p['body'] ?? '').slice(0, 60)}` })
  }
}

// ── Formatting ────────────────────────────────────────────────────────────────

function _who(p: Record<string, unknown>): string {
  const prof = (typeof p['profile'] === 'object' && p['profile'] !== null
    ? p['profile'] as Record<string, unknown>
    : {}) as Record<string, unknown>
  const name = p['name'] ?? prof['name'] ?? prof['pseudonym']
  if (name) return String(name)
  const w = String(p['proxyWallet'] ?? '')
  return w ? `${w.slice(0, 6)}…` : 'anon'
}

/** Trading-desk money: thousands grouped and rounded, cents below $1000. */
function _money(n: number): string {
  return n >= 1000 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2)
}

function _clock(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
}
