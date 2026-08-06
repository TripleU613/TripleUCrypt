// Browser-safe pure computation helpers (no server imports)

import { intervalSecs } from './intervals.js'

export interface TimeSlot {
  label: string
  ts: number
  is_current: boolean
  is_past: boolean
  is_viewing: boolean
  result: string
}

export interface ComputedPosition extends Record<string, unknown> {
  dust: boolean
  value_usd: number
  pnl_usd: number
  pnl_pct: number
  cur_ask: number
  cur_bid: number
}

export function computeTimeSlots(
  windows: Record<string, unknown>[],
  slotOffset: number,
  viewingSlot: string,
  slotResults: Record<string, string>,
  nowTs: number,
  // half-width: slots run from -span..+span (current at the centre). Default 2
  // → 5 slots (desktop). Mobile passes a larger span to fill the screen width.
  span = 2,
): TimeSlot[] {
  if (!windows.length) {
    return Array.from({ length: span * 2 + 1 }, () => ({
      label: '--:--', ts: 0, is_current: false, is_past: false, is_viewing: false, result: '',
    }))
  }

  const active = windows[0]
  const endTs = (active['end_ts'] as number) ?? 0
  const winSecs = intervalSecs((active['interval'] as string) ?? '5m')
  const slots: TimeSlot[] = []

  for (let i = -span; i <= span; i++) {
    const slotEndTs = endTs + (i + slotOffset) * winSecs
    const slotStartTs = slotEndTs - winSecs
    const d = new Date(slotStartTs * 1000)
    const label = slotStartTs
      ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
      : '--:--'
    const slotKey = String(slotStartTs)
    slots.push({
      label,
      ts: slotStartTs,
      is_current: i === 0 && slotOffset === 0,
      is_past: slotEndTs <= nowTs,
      is_viewing: viewingSlot !== '' ? viewingSlot === slotKey : (i === 0 && slotOffset === 0),
      result: slotResults[slotKey] ?? '',
    })
  }
  return slots
}

export function computePositionsLive(
  positions: Record<string, unknown>[],
  tokenAsks: Record<string, number>,
  tokenBids: Record<string, number>,
): ComputedPosition[] {
  return positions.map(pos => {
    const shares = (pos['shares'] as number) ?? 0
    const avgPrice = (pos['avg_price'] as number) ?? 0
    const tokenId = (pos['token'] as string) ?? ''
    const curBid = tokenBids[tokenId] ?? 0
    const curAsk = tokenAsks[tokenId] ?? 0
    const dust = shares < 1e-4
    const valueUsd = (shares * curBid) / 100
    const costUsd = (shares * avgPrice) / 100
    const pnlUsd = valueUsd - costUsd
    const pnlPct = costUsd > 0 ? (pnlUsd / costUsd) * 100 : 0
    return { ...pos, dust, value_usd: valueUsd, pnl_usd: pnlUsd, pnl_pct: pnlPct, cur_ask: curAsk, cur_bid: curBid }
  })
}

export function computeClaimablePositions(
  positions: Record<string, unknown>[],
): Record<string, unknown>[] {
  return positions.filter(p => (p['resolved'] as boolean) && (p['redeemable'] as boolean))
}
