/**
 * Onboarding gate: whether live mode believes it can sign.
 *
 * The bug these pin: `trading_configured` was derived from the SERVER broker
 * alone, so a user who intended to sign in their own browser wallet was told
 * "add credentials to .env" and left with dead trade buttons — the safest setup
 * being pointed at the riskiest one.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

const h = vi.hoisted(() => ({ broker: null as unknown }))

vi.mock('../../src/banking/index.js', () => ({
  getBroker: () => h.broker,
  recordBuyWindow: () => {},
  slippageCapCents: () => 50,
  armLiveOps: () => {},
  allowanceStatus: async () => null,
}))

import { state, patch } from '../../src/engine/state.js'
import { bus } from '../../src/bus.js'
import { liveSignerReady, togglePractice } from '../../src/engine/trading.js'
import { setSignMode, toggleSignMode } from '../../src/engine/wallet.js'

// Toasts are ephemeral SSE events, not state — capture them off the bus.
let toasts: { level: string; text: string }[] = []
bus.on('notify', (n: unknown) => { toasts.push(n as { level: string; text: string }) })

beforeEach(() => {
  toasts = []
  h.broker = null
  patch('practice', true)
  patch('sign_mode', 'instant')
  patch('trading_configured', true)
})

describe('liveSignerReady', () => {
  it('is false with no server broker and no browser wallet', () => {
    expect(liveSignerReady()).toBe(false)
  })

  it('is true on a server broker alone (.env key / generated wallet)', () => {
    h.broker = {}
    expect(liveSignerReady()).toBe(true)
  })

  it('is true on browser signing alone — no server key needed', () => {
    patch('sign_mode', 'wallet')
    expect(liveSignerReady()).toBe(true)
  })
})

describe('setSignMode', () => {
  it('enables trading immediately when switching to browser signing', () => {
    patch('practice', false)
    patch('trading_configured', false)
    setSignMode('wallet')
    // Not "after the next 5s scoreboard poll" — now.
    expect(state.trading_configured).toBe(true)
  })

  it('disables trading again when switching back with no server key', () => {
    patch('practice', false)
    patch('sign_mode', 'wallet')
    patch('trading_configured', true)
    setSignMode('instant')
    expect(state.trading_configured).toBe(false)
  })

  it('leaves practice mode configured regardless of signer', () => {
    setSignMode('instant')
    expect(state.trading_configured).toBe(true)
  })

  it('toggleSignMode gets the same immediate settle', () => {
    patch('practice', false)
    patch('trading_configured', false)
    toggleSignMode()
    expect(state.sign_mode).toBe('wallet')
    expect(state.trading_configured).toBe(true)
  })
})

describe('togglePractice → live', () => {
  it('does not tell a browser-wallet user to edit .env', () => {
    patch('sign_mode', 'wallet')
    patch('practice', true)
    togglePractice()
    expect(state.practice).toBe(false)
    expect(state.trading_configured).toBe(true)
    expect(toasts.map(t => t.text).join(' ').toLowerCase()).not.toContain('.env')
  })

  it('with no signer at all, points at both options rather than only .env', () => {
    patch('practice', true)
    togglePractice()
    expect(state.trading_configured).toBe(false)
    const msg = toasts.map(t => t.text).join(' ').toLowerCase()
    expect(msg).toContain('browser wallet')
    expect(msg).toContain('server wallet')
    // A missing signer is a next step, not a failure — don't flash it red.
    expect(toasts.every(t => t.level !== 'error')).toBe(true)
  })
})
