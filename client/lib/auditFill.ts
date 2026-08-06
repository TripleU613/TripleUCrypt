/**
 * auditBrowserFill — give browser-signed trades the same durable record and
 * post-fill verification that server-signed trades get.
 *
 * WHY THIS EXISTS
 * ---------------
 * In browser ("Wallet") mode the order is built, signed and posted entirely
 * client-side. The server never sees it. That meant those fills produced NO
 * audit-log entry and NO reconciliation, while server-mode fills produced both.
 * For real money that asymmetry is backwards: browser mode is the zero-custody
 * path a user is most likely to trust, and it was the one with no paper trail.
 *
 * So after a browser fill we:
 *   1. verify the position actually moved, using the public data-api (no key
 *      needed — the wallet address is public), and
 *   2. report the fill AND the verification result to the server, which appends
 *      it to trade_audit.jsonl.
 *
 * Fire-and-forget by design: the trade has already happened. Nothing here can
 * fail in a way that affects it, and nothing here blocks the UI.
 */

import { call } from '../api.js'
import { freshHeldSize } from '../buses/ClobTrade.js'

/** Matches the reconcile delays used server-side: position indexing lags a fill
 *  by a second or two, so a single immediate look would cry wolf constantly. */
const DELAYS_MS = [1_500, 3_000, 6_000]
const EPS = 1e-3

export interface BrowserFillRecord {
  asset?: string
  direction?: string
  token?: string
  shares?: number
  price_cents?: number
  usd?: number
  ref?: string
  partial?: boolean
}

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/**
 * @param target     the holding we expect once settled
 * @param comparison 'atLeast' for a buy (holding must reach target),
 *                   'atMost'  for a sell (holding must fall to target)
 */
export async function auditBrowserFill(
  action: 'buy' | 'sell',
  rec: BrowserFillRecord,
  address: string,
  target: number,
  comparison: 'atLeast' | 'atMost',
): Promise<void> {
  let observed: number | null = null
  let ok = false

  if (rec.token && address) {
    for (const d of DELAYS_MS) {
      await sleep(d)
      let held: number | null = null
      try {
        const fresh = await freshHeldSize(address, rec.token)
        held = fresh ? fresh.size : null
      } catch {
        held = null
      }
      if (held == null) continue
      // Track the reading closest to what settlement should look like.
      if (comparison === 'atLeast') {
        if (observed == null || held > observed) observed = held
        if (held + EPS >= target) { ok = true; break }
      } else {
        if (observed == null || held < observed) observed = held
        if (held <= target + EPS) { ok = true; break }
      }
    }
  }

  if (!ok) {
    const what = action === 'buy'
      ? `expected at least ${target.toFixed(2)} shares, saw ${observed == null ? 'unreadable' : observed.toFixed(2)}`
      : `expected at most ${target.toFixed(2)} shares left, saw ${observed == null ? 'unreadable' : observed.toFixed(2)}`
    console.error(`[reconcile] browser ${action} unconfirmed — ${what}`)
  }

  try {
    await call('record_browser_fill', {
      action,
      ...rec,
      ...(ok ? {} : { unreconciled: true, observed_shares: observed ?? 0 }),
    })
  } catch (e) {
    // The audit write failing must never look like the trade failing.
    console.warn('[audit] could not record browser fill:', (e as Error)?.message)
  }
}
