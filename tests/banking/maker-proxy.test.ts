/**
 * Maker selection for the SERVER wallet: bare EOA vs. Polymarket proxy.
 *
 * The bugs these pin, all from the same root cause — a generated wallet is NOT itself
 * a valid Polymarket maker (the CLOB answers "maker address not allowed, please use
 * the deposit wallet flow"). Once onboarded it owns a proxy, and orders must be signed
 * against THAT (funder = proxy, signature_type 2):
 *
 *  1. _keySource() signed type 0 as the bare EOA regardless, so server mode could
 *     never place an accepted order.
 *  2. Money/positions were read from the EOA (_liveAddress) while trading against the
 *     proxy — an account holding real collateral and positions displayed as empty.
 *  3. ensureReady/redeem/send branched on WHERE THE KEY IS STORED ("local") rather
 *     than WHAT THE MAKER IS, so a proxy-onboarded wallet ran EOA-only operations
 *     against the empty EOA — and ensureReady then reported "ready", a false green
 *     light on a real-money path.
 *
 * These assert against the real module with a temp TC_DATA_DIR + on-disk wallet, so
 * they exercise the actual settings/keySource plumbing rather than a mock of it.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

// Isolated data dir BEFORE importing anything that reads it at module scope.
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tuc-maker-'))
process.env['TC_DATA_DIR'] = DIR
// Ensure the .env path is not taken — these tests are about the local wallet.
delete process.env['POLY_PRIVATE_KEY']
delete process.env['POLY_WALLET_ADDRESS']
delete process.env['POLY_API_KEY']
delete process.env['POLY_API_SECRET']
delete process.env['POLY_PASSPHRASE']

// A throwaway key (public test vector — hardhat account #0). Never used for funds.
const TEST_PK = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const TEST_EOA = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const PROXY = '0x1111111111111111111111111111111111111111'

// On-disk format is {address, private_key} (see local-wallet.ts) — address() reads
// the stored field rather than deriving it, so both must be present.
fs.writeFileSync(path.join(DIR, 'trading_wallet.json'), JSON.stringify({ address: TEST_EOA, private_key: TEST_PK }))

const { getPolyProxy, setPolyProxy, flushSettingsSync } = await import('../../src/io/settings.js')
const live = await import('../../src/banking/live.js')

// _keySource is module-private; exercise it through the exported surface that uses it.
// resetLiveClient() drops the cached client so each case re-reads the proxy setting.
function reset(): void { live.resetLiveClient() }

beforeEach(() => {
  setPolyProxy('')
  flushSettingsSync()
  reset()
})

afterAll(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }) } catch { /* */ }
})

describe('server-wallet maker selection', () => {
  it('persists and clears the proxy through settings', () => {
    expect(getPolyProxy()).toBe('')
    setPolyProxy(PROXY); flushSettingsSync()
    expect(getPolyProxy()).toBe(PROXY)
    setPolyProxy(''); flushSettingsSync()
    expect(getPolyProxy()).toBe('')
  })

  it('trims whitespace so a pasted address with spaces still matches', () => {
    setPolyProxy(`  ${PROXY}  `); flushSettingsSync()
    expect(getPolyProxy()).toBe(PROXY)
  })

  it('reads the deposit address from the EOA before onboarding', async () => {
    const b = new live.LiveBroker()
    const d = await b.depositAddress() as { address?: string }
    expect((d.address ?? '').toLowerCase()).toBe(TEST_EOA.toLowerCase())
  })

  it('reads the deposit address from the PROXY once onboarded', async () => {
    // Regression: this returned the EOA, so a user funding "their" address sent money
    // to an account that holds no tradeable collateral.
    setPolyProxy(PROXY); flushSettingsSync(); reset()
    const b = new live.LiveBroker()
    const d = await b.depositAddress() as { address?: string }
    expect((d.address ?? '').toLowerCase()).toBe(PROXY.toLowerCase())
  })

  it('refuses to withdraw from a proxy maker instead of silently sending from the empty EOA', async () => {
    // Regression: send() branched on source==='local' and moved the EOA's USDC even
    // when the money lived in the proxy — a wrong-account transfer.
    setPolyProxy(PROXY); flushSettingsSync(); reset()
    const b = new live.LiveBroker()
    const r = await b.send(1, '0x2222222222222222222222222222222222222222')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Polymarket wallet|withdraw/i)
  })

  it('refuses EOA redeem for a proxy maker rather than redeeming the wrong account', async () => {
    setPolyProxy(PROXY); flushSettingsSync(); reset()
    const b = new live.LiveBroker()
    const r = await b.redeem('0x' + 'ab'.repeat(32))
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/not implemented/i)
  })

  it('resetMakerState clears cached per-maker readiness verdicts', () => {
    // Regression: _readyDone/_tradeableOk are cached per maker. Left set across a
    // proxy change, a new account inherited "already ready" without its allowances
    // ever being checked.
    const b = new live.LiveBroker() as unknown as {
      _readyDone: boolean; _tradeableOk: boolean; resetMakerState(): void
    }
    b._readyDone = true
    b._tradeableOk = true
    b.resetMakerState()
    expect(b._readyDone).toBe(false)
    expect(b._tradeableOk).toBe(false)
  })
})

describe('onboarding browser navigation allowlist', () => {
  it('permits Polymarket and its subdomains over https', async () => {
    const { isAllowedNavTarget } = await import('../../src/onboard/browser.js')
    expect(isAllowedNavTarget('https://polymarket.com/')).toBe(true)
    expect(isAllowedNavTarget('https://polymarket.com/deposit')).toBe(true)
    expect(isAllowedNavTarget('https://www.polymarket.com/')).toBe(true)
  })

  it('refuses internal and non-https targets', async () => {
    // The server browser runs --no-sandbox next to the trading engine and renders
    // whatever it loads back to the caller as frames, so an unrestricted goto() would
    // be a read-through SSRF into cloud metadata / localhost / the filesystem.
    const { isAllowedNavTarget } = await import('../../src/onboard/browser.js')
    expect(isAllowedNavTarget('http://169.254.169.254/latest/meta-data/')).toBe(false)
    expect(isAllowedNavTarget('http://localhost:8200/health')).toBe(false)
    expect(isAllowedNavTarget('file:///etc/passwd')).toBe(false)
    expect(isAllowedNavTarget('https://127.0.0.1/')).toBe(false)
    expect(isAllowedNavTarget('not a url')).toBe(false)
  })

  it('is not fooled by a lookalike host suffix', async () => {
    const { isAllowedNavTarget } = await import('../../src/onboard/browser.js')
    expect(isAllowedNavTarget('https://polymarket.com.evil.tld/')).toBe(false)
    expect(isAllowedNavTarget('https://notpolymarket.com/')).toBe(false)
  })
})
