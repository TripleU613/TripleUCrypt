import { patch, sleep } from './state.js'
import type { AppState } from './state.js'
import { bus } from '../bus.js'
import WebSocket from 'ws'
import { guardSocket } from '../io/ws-guard.js'

// ── IO imports ────────────────────────────────────────────────────────────────

type KrakenModule = {
  wsSubscriptions(): Record<string, unknown>[]
  parseWsMessage(msg: Record<string, unknown>): {type: string; symbol?: string; price?: number; change_pct?: number} | null
  WS_URL?: string
}

let _kraken: KrakenModule | null = null
let KRAKEN_WS_URL = 'wss://ws.kraken.com/v2'

try {
  _kraken = await import('../io/kraken.js') as unknown as KrakenModule
  KRAKEN_WS_URL = _kraken.WS_URL ?? KRAKEN_WS_URL
} catch {
  // kraken io not available
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface TickerPending {
  price: number
  change: number
  hi: number
  lo: number
}

// Symbol → asset name mapping (Kraken uses XBT/USD for BTC)
const SYMBOL_TO_ASSET: Record<string, string> = {
  'XBT/USD': 'BTC',
  'ETH/USD': 'ETH',
  'SOL/USD': 'SOL',
  'XRP/USD': 'XRP',
  'DOGE/USD': 'DOGE',
  'HYPE/USD': 'HYPE',
  'BNB/USD': 'BNB',
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initState(s: AppState): void {
  s.btc_price = 0
  s.btc_change = 0
  s.eth_price = 0
  s.sol_price = 0
  s.xrp_price = 0
  s.doge_price = 0
  s.hype_price = 0
  s.bnb_price = 0
}

// ── Apply tickers ─────────────────────────────────────────────────────────────

export function applyTickers(pending: Map<string, TickerPending>): void {
  for (const [asset, data] of pending) {
    const a = asset.toUpperCase()
    switch (a) {
      case 'BTC':  patch('btc_price', data.price);  patch('btc_change', data.change);  break
      case 'ETH':  patch('eth_price', data.price);  break
      case 'SOL':  patch('sol_price', data.price);  break
      case 'XRP':  patch('xrp_price', data.price);  break
      case 'DOGE': patch('doge_price', data.price); break
      case 'HYPE': patch('hype_price', data.price); break
      case 'BNB':  patch('bnb_price', data.price);  break
    }
    bus.emit('kraken_tick', asset, data.price, data.change)
  }
}

// ── Background: stream Kraken prices ─────────────────────────────────────────

export async function runStreamKraken(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    if (!_kraken) {
      await sleep(5000)
      continue
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(KRAKEN_WS_URL)
        // Half-open sockets never fire close/error, which would hang this loop
        // forever. Ping/pong probe terminates a dead peer so the loop reconnects.
        guardSocket(ws, { label: 'kraken', staleMs: 45000 })

        ws.on('open', () => {
          for (const sub of _kraken!.wsSubscriptions()) {
            ws.send(JSON.stringify(sub))
          }
        })

        ws.on('message', (data: Buffer) => {
          if (signal.aborted) { ws.close(); resolve(); return }
          try {
            const raw = JSON.parse(data.toString()) as Record<string, unknown>
            const result = _kraken!.parseWsMessage(raw)
            if (!result || result.type !== 'ticker') return

            const symbol = result.symbol ?? ''
            const asset = SYMBOL_TO_ASSET[symbol] ?? symbol.split('/')[0]
            if (!asset) return

            applyTickers(new Map([[asset, {
              price: result.price ?? 0,
              change: result.change_pct ?? 0,
              hi: 0,
              lo: 0,
            }]]))
          } catch {
            // parse error
          }
        })

        ws.on('error', reject)
        ws.on('close', resolve)

        signal.addEventListener('abort', () => { ws.close(); resolve() }, { once: true })
      })
    } catch {
      // reconnect
    }

    if (!signal.aborted) {
      await sleep(3000)
    }
  }
}
