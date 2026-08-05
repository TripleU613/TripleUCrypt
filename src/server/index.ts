/**
 * TripleUCrypt Express server.
 *
 * Routes:
 *   GET  /health        — health check
 *   GET  /sse           — SSE state stream (snapshot + patches)
 *   POST /action/:name  — dispatch UI event handlers
 *   GET  *              — SPA fallback (serves dist/public/index.html)
 */
import express from 'express'
import path from 'path'
import { fileURLToPath } from 'url'

import { initAllState, runAllBackgroundTasks, backgroundTaskHealth } from '../engine/index.js'
import { bumpGeneration, getSignal } from '../engine/session.js'
import { sseHandler } from './sse.js'
import { dispatch } from './actions.js'
import { flushSettingsSync } from '../io/settings.js'

const app = express()

// ── CLOB proxy (browser-wallet trading) ──────────────────────────────────────
// The browser routes Polymarket CLOB calls through here (same-origin → no CORS /
// Cloudflare-bot / network-error issues). Forward the RAW body verbatim — the
// poly_signature HMAC is computed over the exact bytes, so re-serializing breaks
// it. Mounted before express.json() so the JSON parser never touches /clob.
app.use('/clob', express.raw({ type: () => true, limit: '2mb' }), async (req, res) => {
  try {
    const target = 'https://clob.polymarket.com' + req.url
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase()
      if ((lk.startsWith('poly_') || lk === 'content-type' || lk === 'accept') && typeof v === 'string') headers[k] = v
    }
    const init: RequestInit = { method: req.method, headers }
    const body = req.body as Buffer | undefined
    if (req.method !== 'GET' && req.method !== 'HEAD' && body && body.length) init.body = new Uint8Array(body)
    const r = await fetch(target, init)
    const buf = Buffer.from(await r.arrayBuffer())
    res.status(r.status)
    const ct = r.headers.get('content-type'); if (ct) res.set('content-type', ct)
    res.send(buf)
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e instanceof Error ? e.message : e) })
  }
})

app.use(express.json())

// ── Static files (Vite build output) ─────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// build layout: dist/server/index.js + dist/public  →  ../public
const publicDir = path.join(__dirname, '../public')
app.use(express.static(publicDir))

// ── Health check ──────────────────────────────────────────────────────────────

// `ok` intentionally does NOT go false on a single crashed-and-restarting feed —
// this endpoint gates the Docker healthcheck and the deploy rollout, and
// restarting the process over a self-healing feed hiccup would kill in-flight
// orders. `degraded` + `tasks[]` expose that detail for operators/alerting.
app.get('/health', (_req, res) => {
  const bg = backgroundTaskHealth()
  res.json({ ok: bg.ok, degraded: bg.degraded, ts: Date.now(), tasks: bg.tasks })
})

// ── SSE state stream ──────────────────────────────────────────────────────────

app.get('/sse', sseHandler)

// ── Action dispatch ───────────────────────────────────────────────────────────

app.post('/action/:name', (req, res) => {
  const { name } = req.params
  const args: unknown[] = (req.body as { args?: unknown[] })?.args ?? []

  dispatch(name, args)
    .then(() => res.json({ ok: true }))
    .catch((err: unknown) => {
      res.status(400).json({ ok: false, error: String(err) })
    })
})

// ── Allowance status (browser-wallet mode, read-only, no key) ─────────────────
app.get('/allowance', (req, res) => {
  const address = String(req.query['address'] ?? '')
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) { res.status(400).json({ ok: false, error: 'bad address' }); return }
  import('../banking/eoa-allowance.js').then(async ({ allowanceStatus }) => {
    const status = await allowanceStatus(address)
    res.json({ ok: true, status })
  }).catch((err: unknown) => res.status(400).json({ ok: false, error: String(err instanceof Error ? err.message : err) }))
})

// ── Swap quote (browser-wallet mode) ─────────────────────────────────────────
// Build a 0x swap quote server-side (the API key lives here) and return the
// unsigned tx so the connected wallet can sign + send it in the browser.
app.post('/swap-quote', (req, res) => {
  const b = (req.body ?? {}) as { sell?: string; buy?: string; amount?: number; taker?: string }
  const MAP: Record<string, 'USDC_NATIVE' | 'USDC_E' | 'POL'> = { 'USDC': 'USDC_NATIVE', 'USDC.e': 'USDC_E', 'POL': 'POL' }
  const sell = MAP[b.sell ?? ''], buy = MAP[b.buy ?? '']
  const amount = Number(b.amount), taker = String(b.taker ?? '')
  if (!sell || !buy || !(amount > 0) || !/^0x[0-9a-fA-F]{40}$/.test(taker)) {
    res.status(400).json({ ok: false, error: 'Bad swap params' }); return
  }
  import('../banking/swap.js').then(async ({ getSwapQuote }) => {
    const base = sell === 'POL' ? BigInt(Math.round(amount * 1e18)) : BigInt(Math.round(amount * 1e6))
    const q = await getSwapQuote({ sell, buy, sellAmount: base, taker })
    res.json({ ok: true, quote: {
      to: q.to, data: q.data, value: q.value.toString(), sellToken: q.sellToken,
      allowanceTarget: q.allowanceTarget, buyAmount: q.buyAmount.toString(), minBuyAmount: q.minBuyAmount.toString(),
    } })
  }).catch((err: unknown) => res.status(400).json({ ok: false, error: String(err instanceof Error ? err.message : err) }))
})

// ── SPA fallback ──────────────────────────────────────────────────────────────

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'), err => {
    if (err) {
      // In dev mode, Vite serves the frontend separately — 404 is expected
      res.status(404).json({ ok: false, error: 'Not found' })
    }
  })
})

// ── Bootstrap ─────────────────────────────────────────────────────────────────

initAllState()

const PORT = parseInt(process.env['PORT'] ?? '8200', 10)

app.listen(PORT, () => {
  console.log(`TripleUCrypt server on :${PORT}`)
  bumpGeneration()
  runAllBackgroundTasks(getSignal()).catch(console.error)
})

// Flush any pending (debounced) settings write before the process goes away,
// so a quick exit can't drop the latest preference change.
let _exiting = false
function _onExit(): void {
  if (_exiting) return
  _exiting = true
  flushSettingsSync()
  process.exit(0)
}
process.on('SIGINT', _onExit)
process.on('SIGTERM', _onExit)
process.on('beforeExit', () => flushSettingsSync())

// ── Last-resort crash visibility ─────────────────────────────────────────────
// Without these, a throw outside any try/catch just kills the process and the
// supervisor (Docker restart:unless-stopped / the NSSM service) brings it back
// with NO stack trace anywhere durable — the incident reads as "it died".
//
// unhandledRejection only logs: Node's current default is a warning, and a
// rejected promise somewhere is not itself proof that trading state is corrupt.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason)
})

// uncaughtException DOES exit. Continuing after one means running on state that
// may be half-updated — unacceptable while holding real positions — so flush
// settings and let the supervisor restart into a clean process.
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err)
  try { flushSettingsSync() } catch { /* already crashing — don't mask the real error */ }
  process.exit(1)
})

export { app }
