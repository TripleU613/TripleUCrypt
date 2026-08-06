/**
 * clobLazy — the lazy boundary in front of the browser-wallet signing stack.
 *
 * WHY
 * ---
 * buses/ClobTrade.ts imports ethers v5 + @polymarket/clob-client-v2 (+ the Buffer
 * shim the node-polyfill plugin injects for them). Source-map attribution put that
 * at ~379 kB of an ~880 kB bundle -- roughly 43% -- and NONE of it runs unless the
 * user is in live mode with sign_mode='wallet'. Practice mode is the default, so
 * most sessions download the entire web3 stack and never execute a line of it.
 *
 * Everything here is therefore reached through dynamic import(), so Rollup emits
 * it as a separate chunk that is only fetched on first use.
 *
 * WHY NOT manualChunks
 * --------------------
 * A previous attempt split these vendors with Vite's build.rollupOptions.output
 * .manualChunks and produced a circular chunk-init TDZ crash in production
 * ("can't access lexical declaration before initialization"). Slicing
 * interdependent vendor libs across chunk boundaries lets two chunks require each
 * other at module-init time. A dynamic import() cannot do that: the dependency is
 * strictly one-way (this module statically imports nothing from ClobTrade; it only
 * import()s it), so there is no cycle to deadlock.
 *
 * NOTE the pure slippage maths deliberately does NOT live behind this boundary --
 * see lib/slippage.ts. placeTrade needs it synchronously.
 */

type ClobModule = typeof import('./ClobTrade.js')

let _mod: Promise<ClobModule> | null = null

/** Load (once) and cache the signing module. */
function mod(): Promise<ClobModule> {
  if (!_mod) _mod = import('./ClobTrade.js')
  return _mod
}

/**
 * Start fetching the chunk without needing it yet.
 *
 * Call this the moment the user looks like they might trade (switching to wallet
 * mode, opening the wallet panel) so the network fetch overlaps their next action
 * instead of landing in the middle of a buy click. Fire-and-forget: a failure here
 * is retried by the real call.
 */
export function warmClob(): void {
  void mod().catch(() => { _mod = null })
}

// ── Thin async pass-throughs ─────────────────────────────────────────────────
// Each mirrors the ClobTrade export exactly, but returns a promise because the
// module has to arrive first. Every existing call site was already async.

export async function browserBuy(
  ...args: Parameters<ClobModule['browserBuy']>
): ReturnType<ClobModule['browserBuy']> {
  return (await mod()).browserBuy(...args)
}

export async function browserSell(
  ...args: Parameters<ClobModule['browserSell']>
): ReturnType<ClobModule['browserSell']> {
  return (await mod()).browserSell(...args)
}

export async function ensureBrowserApprovals(
  ...args: Parameters<ClobModule['ensureBrowserApprovals']>
): ReturnType<ClobModule['ensureBrowserApprovals']> {
  return (await mod()).ensureBrowserApprovals(...args)
}

export async function refreshBrowserPortfolio(
  ...args: Parameters<ClobModule['refreshBrowserPortfolio']>
): ReturnType<ClobModule['refreshBrowserPortfolio']> {
  return (await mod()).refreshBrowserPortfolio(...args)
}

export async function freshHeldSize(
  ...args: Parameters<ClobModule['freshHeldSize']>
): ReturnType<ClobModule['freshHeldSize']> {
  return (await mod()).freshHeldSize(...args)
}

/**
 * Fire-and-forget: the one caller invokes this from a synchronous handler on
 * wallet disconnect/account-switch. Clearing a cache slightly later is harmless —
 * and if the module was never loaded there is no cache to clear, so this becomes
 * a no-op rather than pulling 379 kB in to clear nothing.
 */
export function resetClobCaches(): void {
  if (!_mod) return
  void _mod.then(m => m.resetClobCaches()).catch(() => {})
}
