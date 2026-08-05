/**
 * eoa-allowance — gate + refusal coverage for the real-money on-chain paths
 * (approvals, withdraw, redeem) and the swap/gas gate.
 *
 * SCOPE, DELIBERATELY NARROW
 * --------------------------
 * These tests assert what must NOT happen: that nothing here broadcasts a
 * transaction while the gates are closed, and that the known-unsafe branches
 * refuse instead of guessing. Every assertion targets a check that runs BEFORE
 * any network/chain call, so no viem mocking is needed and there is no risk of a
 * fake happy path implying the on-chain flows are verified — they are not, and
 * they still require live-account verification.
 *
 * `_armed` is module-scoped and armLiveOps() never resets, so every test
 * re-imports the module fresh (vi.resetModules) and restores env, or a single
 * armed test would silently open the gate for the rest of the file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const GATE_ENV = [
  'TUC_EOA_APPROVE_ENABLED',
  'TUC_REDEEM_ENABLED',
  'TUC_SWAP_ENABLED',
] as const

// A syntactically valid key that funds nothing — the gate must reject before it
// is ever used to sign. (Hardhat/Anvil default account #0, publicly documented.)
const DUMMY_KEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const DUMMY_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const DUMMY_COND = '0x' + '11'.repeat(32)

type Mod = typeof import('../../src/banking/eoa-allowance.js')

/** Fresh module instance so `_armed` never leaks between tests. */
async function freshModule(): Promise<Mod> {
  vi.resetModules()
  return import('../../src/banking/eoa-allowance.js')
}

let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  savedEnv = {}
  for (const k of GATE_ENV) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})

afterEach(() => {
  for (const k of GATE_ENV) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  vi.restoreAllMocks()
})

describe('eoa-allowance — gates default CLOSED', () => {
  it('ensureEoaAllowances refuses when neither armed nor env-flagged', async () => {
    const m = await freshModule()
    expect(m.liveOpsArmed()).toBe(false)
    await expect(m.ensureEoaAllowances(DUMMY_KEY)).rejects.toThrow(/not enabled/i)
  })

  it('eoaWithdraw refuses when neither armed nor env-flagged', async () => {
    const m = await freshModule()
    await expect(m.eoaWithdraw(DUMMY_KEY, DUMMY_ADDR, 1_000_000n)).rejects.toThrow(/not enabled/i)
  })

  it('redeemEoa refuses when neither armed nor env-flagged', async () => {
    const m = await freshModule()
    await expect(m.redeemEoa(DUMMY_KEY, DUMMY_COND)).rejects.toThrow(/not enabled/i)
  })

  it('swapEnabled (Swap card / Get gas) is false by default', async () => {
    const m = await freshModule()
    expect(m.swapEnabled()).toBe(false)
  })

  it('the gate blocks BEFORE any network call is attempted', async () => {
    const m = await freshModule()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(m.redeemEoa(DUMMY_KEY, DUMMY_COND)).rejects.toThrow(/not enabled/i)
    // A closed gate must not even probe the market type.
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('eoa-allowance — armLiveOps() opens every gate for the process', () => {
  it('arming flips liveOpsArmed and swapEnabled', async () => {
    const m = await freshModule()
    expect(m.swapEnabled()).toBe(false)
    m.armLiveOps()
    expect(m.liveOpsArmed()).toBe(true)
    expect(m.swapEnabled()).toBe(true)
  })

  it('arming lets withdraw past the gate and onto its own validation', async () => {
    const m = await freshModule()
    m.armLiveOps()
    // Now the gate is open, so a non-positive amount must be caught by the
    // NEXT check — proving we got past the gate, not around the validation.
    await expect(m.eoaWithdraw(DUMMY_KEY, DUMMY_ADDR, 0n)).rejects.toThrow(/must be positive/i)
  })

  it('arming does NOT leak into a freshly-imported module', async () => {
    const armed = await freshModule()
    armed.armLiveOps()
    expect(armed.liveOpsArmed()).toBe(true)

    const clean = await freshModule()
    expect(clean.liveOpsArmed()).toBe(false)
    expect(clean.swapEnabled()).toBe(false)
  })
})

describe('eoa-allowance — legacy env flags open their own gate only', () => {
  it('TUC_EOA_APPROVE_ENABLED opens approvals/withdraw but not swap or redeem', async () => {
    process.env['TUC_EOA_APPROVE_ENABLED'] = '1'
    const m = await freshModule()
    expect(m.swapEnabled()).toBe(false)
    // Past the gate → stopped by withdraw's own amount validation.
    await expect(m.eoaWithdraw(DUMMY_KEY, DUMMY_ADDR, 0n)).rejects.toThrow(/must be positive/i)
    // Redeem has a separate flag and stays shut.
    await expect(m.redeemEoa(DUMMY_KEY, DUMMY_COND)).rejects.toThrow(/not enabled/i)
  })

  it('TUC_REDEEM_ENABLED opens redeem but not approvals/withdraw', async () => {
    process.env['TUC_REDEEM_ENABLED'] = '1'
    const m = await freshModule()
    await expect(m.ensureEoaAllowances(DUMMY_KEY)).rejects.toThrow(/not enabled/i)
    // Past the redeem gate → stopped by its own conditionId validation.
    await expect(m.redeemEoa(DUMMY_KEY, '')).rejects.toThrow(/missing condition_id/i)
  })

  it('TUC_SWAP_ENABLED opens only the swap/gas gate', async () => {
    process.env['TUC_SWAP_ENABLED'] = '1'
    const m = await freshModule()
    expect(m.swapEnabled()).toBe(true)
    expect(m.liveOpsArmed()).toBe(false)   // env flag ≠ armed
    await expect(m.ensureEoaAllowances(DUMMY_KEY)).rejects.toThrow(/not enabled/i)
  })

  it('accepts the documented truthy spellings, rejects everything else', async () => {
    for (const v of ['1', 'true', 'yes', 'on', 'TRUE', ' On ']) {
      process.env['TUC_SWAP_ENABLED'] = v
      const m = await freshModule()
      expect(m.swapEnabled(), `"${v}" should open the gate`).toBe(true)
    }
    for (const v of ['0', 'false', 'no', 'off', '', 'maybe']) {
      process.env['TUC_SWAP_ENABLED'] = v
      const m = await freshModule()
      expect(m.swapEnabled(), `"${v}" must NOT open the gate`).toBe(false)
    }
  })
})

describe('eoa-allowance — redeem refuses the unsafe routes instead of guessing', () => {
  it('refuses a neg-risk condition rather than firing the wrong CTF call', async () => {
    const m = await freshModule()
    m.armLiveOps()
    // CLOB reports this market as neg-risk. The bare-CTF [1,2] route would
    // revert / strand the winnings, so the code must refuse, not attempt it.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ neg_risk: true }), { status: 200 }),
    )
    await expect(m.redeemEoa(DUMMY_KEY, DUMMY_COND)).rejects.toThrow(/neg-risk redemption not yet supported/i)
  })

  it('reads the camelCase negRisk spelling too', async () => {
    const m = await freshModule()
    m.armLiveOps()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ negRisk: true }), { status: 200 }),
    )
    await expect(m.redeemEoa(DUMMY_KEY, DUMMY_COND)).rejects.toThrow(/neg-risk redemption not yet supported/i)
  })

  it('refuses when the market type is indeterminate (non-OK response)', async () => {
    const m = await freshModule()
    m.armLiveOps()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('nope', { status: 500 }))
    await expect(m.redeemEoa(DUMMY_KEY, DUMMY_COND)).rejects.toThrow(/could not determine market type/i)
  })

  it('refuses when the market type field is missing/not a boolean', async () => {
    const m = await freshModule()
    m.armLiveOps()
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ some_other_field: 'x' }), { status: 200 }),
    )
    await expect(m.redeemEoa(DUMMY_KEY, DUMMY_COND)).rejects.toThrow(/could not determine market type/i)
  })

  it('refuses when the market-type probe throws (network down)', async () => {
    const m = await freshModule()
    m.armLiveOps()
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'))
    await expect(m.redeemEoa(DUMMY_KEY, DUMMY_COND)).rejects.toThrow(/could not determine market type/i)
  })
})

describe('eoa-allowance — withdraw input validation (before any chain write)', () => {
  it.each([0n, -1n, -1_000_000n])('rejects a non-positive amount (%s)', async (amt) => {
    const m = await freshModule()
    m.armLiveOps()
    await expect(m.eoaWithdraw(DUMMY_KEY, DUMMY_ADDR, amt)).rejects.toThrow(/must be positive/i)
  })

  it('rejects a non-positive amount passed as a plain number too', async () => {
    const m = await freshModule()
    m.armLiveOps()
    await expect(m.eoaWithdraw(DUMMY_KEY, DUMMY_ADDR, 0)).rejects.toThrow(/must be positive/i)
  })
})
