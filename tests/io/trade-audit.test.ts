/**
 * The audit log is the only durable record of what this app did with real money.
 * These tests pin the two properties that matter: it writes what it was given,
 * and it NEVER throws into the trading path — a broken disk must not roll back
 * an order that already executed on the exchange.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import { recordTrade, readTradeAudit } from '../../src/io/trade-audit.js'

let dir = ''
const prevDataDir = process.env['TC_DATA_DIR']

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tuc-audit-'))
  process.env['TC_DATA_DIR'] = dir
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.restoreAllMocks()
  if (prevDataDir == null) delete process.env['TC_DATA_DIR']
  else process.env['TC_DATA_DIR'] = prevDataDir
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('trade-audit', () => {
  it('persists a fill and reads it back', () => {
    recordTrade({ action: 'buy', mode: 'live', asset: 'BTC', direction: 'UP', shares: 3, price_cents: 52 })
    const rows = readTradeAudit()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ action: 'buy', mode: 'live', asset: 'BTC', shares: 3, price_cents: 52 })
    expect(typeof rows[0]!.ts).toBe('string')
  })

  it('records a signed-but-rejected order with its reason', () => {
    recordTrade({
      action: 'buy', mode: 'live', asset: 'ETH', direction: 'DOWN',
      signer: 'browser', rejected: true, error: 'not enough balance / allowance',
    })
    const [row] = readTradeAudit()
    expect(row).toMatchObject({ rejected: true, signer: 'browser', error: 'not enough balance / allowance' })
    // A rejection moved no money — it must not carry a fill size that could be
    // summed into a P&L total.
    expect(row!.shares).toBeUndefined()
    expect(row!.price_cents).toBeUndefined()
  })

  it('marks a rejection in the console line so it cannot read as a fill', () => {
    const log = console.log as unknown as ReturnType<typeof vi.fn>
    recordTrade({ action: 'sell', mode: 'live', rejected: true, error: 'book empty' })
    expect(String(log.mock.calls[0]?.[0])).toContain('SELL REJECTED')
  })

  it('appends rather than rewriting, so history survives', () => {
    recordTrade({ action: 'buy', mode: 'live', ref: 'a' })
    recordTrade({ action: 'sell', mode: 'live', ref: 'b' })
    expect(readTradeAudit().map(r => r.ref)).toEqual(['a', 'b'])
  })

  it('survives an unwritable data dir instead of throwing into the trade path', () => {
    process.env['TC_DATA_DIR'] = path.join(dir, 'blocked')
    fs.writeFileSync(path.join(dir, 'blocked'), 'not a directory')
    expect(() => recordTrade({ action: 'buy', mode: 'live', shares: 1 })).not.toThrow()
  })

  it('returns an empty list when there is no log yet', () => {
    expect(readTradeAudit()).toEqual([])
  })

  it('skips a corrupt line rather than losing the whole file', () => {
    recordTrade({ action: 'buy', mode: 'live', ref: 'good1' })
    fs.appendFileSync(path.join(dir, 'trade_audit.jsonl'), '{ truncated mid-wri\n')
    recordTrade({ action: 'buy', mode: 'live', ref: 'good2' })
    expect(readTradeAudit().map(r => r.ref)).toEqual(['good1', 'good2'])
  })
})
