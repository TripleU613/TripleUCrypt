/**
 * The Polymarket wallet (Gnosis Safe proxy) address to trade as, in browser mode.
 *
 * WHY THIS IS ITS OWN MODULE
 * --------------------------
 * Both buses/ClobTrade.ts (which needs it to build orders) and
 * components/WalletPanel.tsx (which edits it) read this. ClobTrade pulls in ethers +
 * @polymarket/clob-client-v2 -- ~417 kB that is deliberately behind a dynamic import
 * (see buses/clobLazy.ts), so importing ClobTrade from the wallet panel would drag
 * the whole web3 stack back into the entry bundle. This file touches nothing but
 * localStorage, so both sides can import it freely.
 *
 * WHY THE VALUE EXISTS AT ALL
 * ---------------------------
 * Connecting MetaMask to Polymarket creates a Safe PROXY that holds your collateral.
 * That proxy -- not your EOA -- is the allowed maker, so an order signed as the bare
 * EOA is rejected with "maker address not allowed. please use the deposit market
 * flow". No public endpoint resolves an EOA to its proxy (the server path takes
 * POLY_WALLET_ADDRESS as config for the same reason), so the user supplies it.
 */

const FUNDER_KEY = 'tc_poly_funder'

/** Configured Polymarket proxy address, or '' when trading as a bare EOA. */
export function getPolyFunder(): string {
  try {
    return (localStorage.getItem(FUNDER_KEY) ?? '').trim()
  } catch {
    return ''   // private mode / storage disabled
  }
}

/** Persist the address; '' clears it. Callers should reset any cached CLOB client. */
export function setPolyFunder(addr: string): void {
  const v = addr.trim()
  try {
    if (v) localStorage.setItem(FUNDER_KEY, v)
    else localStorage.removeItem(FUNDER_KEY)
  } catch {
    /* private mode — trading will fall back to the bare-EOA path */
  }
}

/** True when `addr` looks like a checksummable 20-byte hex address. */
export function isAddressLike(addr: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(addr.trim())
}
