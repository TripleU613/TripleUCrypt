/**
 * trade-audit — append-only local record of every executed fill.
 *
 * WHY THIS EXISTS
 * ---------------
 * Fills used to be reported ONLY as an ephemeral SSE toast (`notify()`), with
 * `state.orders` held in memory. A restart (deploy, crash, OOM) between a fill
 * and the next refresh left NO local record of what was traded, at what price,
 * or when — the only source of truth became the Polymarket API / on-chain data.
 * For a real-money terminal that breaks incident investigation and basic
 * reconciliation, so every fill now also lands in a durable JSONL file.
 *
 * INVARIANT: nothing here may throw into the trading path. A failed audit write
 * must never break, block, or roll back a real order — every entry point
 * swallows its own errors and degrades to console-only.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'

/** Same resolution as banking/ledger.ts — TC_DATA_DIR wins, else ~/.triplecrypt. */
function dataDir(): string {
  const d = (process.env['TC_DATA_DIR'] ?? '').trim()
  return d ? d : path.join(os.homedir(), '.triplecrypt')
}

function auditPath(): string {
  return path.join(dataDir(), 'trade_audit.jsonl')
}

export type TradeAction = 'buy' | 'sell' | 'claim'

export interface TradeAuditEntry {
  ts: string              // ISO-8601, UTC
  action: TradeAction
  mode: 'practice' | 'live'
  asset?: string
  direction?: string      // UP / DOWN (buy/sell)
  token?: string
  shares?: number
  price_cents?: number
  usd?: number
  /** CLOB order id, or an on-chain tx hash for claims/redemptions. */
  ref?: string
  /** Set when a FAK sell matched less than requested. */
  partial?: boolean
  /** Positions redeemed (claim only). */
  claimed?: number
}

/**
 * Append one fill to the audit log and mirror it to stdout so it lands in
 * whatever log capture is already configured (docker json-file driver, or the
 * NSSM service.out.log on the Windows box).
 *
 * Never throws — see the file-level invariant.
 */
export function recordTrade(entry: Omit<TradeAuditEntry, 'ts'>): void {
  const full: TradeAuditEntry = { ts: new Date().toISOString(), ...entry }

  // Console first: even if the disk write fails, the fill is still on the record.
  try {
    const bits = [
      `[trade] ${full.action.toUpperCase()}`,
      `mode=${full.mode}`,
      full.asset ? `asset=${full.asset}` : '',
      full.direction ? `dir=${full.direction}` : '',
      full.shares != null ? `shares=${full.shares}` : '',
      full.price_cents != null ? `price=${full.price_cents}c` : '',
      full.usd != null ? `usd=${full.usd}` : '',
      full.claimed != null ? `claimed=${full.claimed}` : '',
      full.partial ? 'PARTIAL' : '',
      full.ref ? `ref=${full.ref}` : '',
    ].filter(Boolean)
    console.log(bits.join(' '))
  } catch { /* logging must never break a fill */ }

  try {
    const dir = dataDir()
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    // Append (not rewrite) so a crash mid-write can at worst truncate the last
    // line rather than corrupt prior history. 0600 — trade history is private.
    fs.appendFileSync(auditPath(), JSON.stringify(full) + '\n', { mode: 0o600 })
  } catch (e) {
    console.warn('[trade] audit write failed (fill itself unaffected):', e instanceof Error ? e.message : e)
  }
}

/** Read back the most recent `limit` entries (newest last). Never throws. */
export function readTradeAudit(limit = 200): TradeAuditEntry[] {
  try {
    const raw = fs.readFileSync(auditPath(), 'utf8')
    const lines = raw.split('\n').filter(l => l.trim().length > 0)
    return lines.slice(-limit).flatMap(l => {
      try { return [JSON.parse(l) as TradeAuditEntry] } catch { return [] }
    })
  } catch {
    return []
  }
}
