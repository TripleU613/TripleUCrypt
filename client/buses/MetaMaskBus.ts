/**
 * MetaMask (EIP-1193) bus — thin wrapper around window.ethereum.
 * Mirrors metamask_bus.py: exposes connect, address reads, and
 * an address-change subscriber.
 *
 * Supports EIP-6963 multi-wallet provider discovery (Rabby, Coinbase
 * Wallet, Frame, etc.) in addition to the legacy window.ethereum injection.
 */

type AddressChangeCallback = (addr: string | null) => void

// ---------------------------------------------------------------------------
// EIP-1193 provider type (minimal)
// ---------------------------------------------------------------------------
interface Eip1193Provider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>
  on?: (event: string, cb: (...args: unknown[]) => void) => void
}

// ---------------------------------------------------------------------------
// Discovered wallets — EIP-6963 announce + legacy window.ethereum
// ---------------------------------------------------------------------------
interface WalletInfo { id: string; name: string; icon: string }
interface Discovered { info: WalletInfo; provider: Eip1193Provider }

const _wallets = new Map<string, Discovered>()
let _provider: Eip1193Provider | null = null
const _walletSubs = new Set<() => void>()

function _emitWallets(): void { for (const cb of _walletSubs) cb() }

if (typeof window !== 'undefined') {
  const eth = (window as unknown as Record<string, unknown>).ethereum as Eip1193Provider | undefined
  if (eth) {
    _wallets.set('injected', { info: { id: 'injected', name: 'Browser Wallet', icon: '' }, provider: eth })
    _provider = eth
  }
  // EIP-6963: collect every announced wallet (Rabby, Coinbase, Brave, Frame…).
  // Wallets announce asynchronously, so we keep listening and notify subscribers
  // as each one shows up (rather than snapshotting once).
  try {
    window.addEventListener('eip6963:announceProvider', (e: Event) => {
      const ev = e as CustomEvent<{ info: { uuid: string; name: string; icon: string; rdns: string }; provider: Eip1193Provider }>
      const d = ev.detail
      if (!d?.provider || !d.info) return
      _wallets.set(d.info.rdns, { info: { id: d.info.rdns, name: d.info.name, icon: d.info.icon }, provider: d.provider })
      if (!_provider) _provider = d.provider
      _emitWallets()
    })
    window.dispatchEvent(new Event('eip6963:requestProvider'))
  } catch (_) {
    // Non-browser environments — swallow
  }
}

/** List the wallets discovered in this browser (for a connect picker). */
export function listWallets(): WalletInfo[] {
  return [..._wallets.values()].map(w => w.info).filter(w => w.id !== 'injected' || _wallets.size === 1)
}

/**
 * Subscribe to wallet discovery — fires whenever a new EIP-6963 wallet
 * announces. Also re-broadcasts the request so installed wallets re-announce
 * (they may have loaded after our initial dispatch). Returns an unsubscribe fn.
 */
export function subscribeWallets(cb: () => void): () => void {
  _walletSubs.add(cb)
  try {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('eip6963:requestProvider'))
  } catch (_) { /* swallow */ }
  return () => { _walletSubs.delete(cb) }
}

// ---------------------------------------------------------------------------
// Address-change tracking
// ---------------------------------------------------------------------------
let _currentAddress: string | null = null
const _listeners: Set<AddressChangeCallback> = new Set()

function _notify(addr: string | null): void {
  _currentAddress = addr
  for (const cb of _listeners) cb(addr)
}

// ---------------------------------------------------------------------------
// shared_001: structured {ok, address, chainId} / {ok: false, error} connect
// ---------------------------------------------------------------------------

/** Connect result discriminated union */
export type ConnectResult =
  | { ok: true; address: string; chainId: string }
  | { ok: false; error: string }

/**
 * Request wallet connection via EIP-1193.
 * Returns a structured result — never throws.
 * Callers use connectMetaMask() directly.
 */
let _activeId: string | null = null

/** The id of the wallet currently connected (for marking it in the picker). */
export function activeWalletId(): string | null { return _activeId }

export async function connectMetaMask(walletId?: string): Promise<ConnectResult> {
  // Pick the chosen wallet (by EIP-6963 rdns id) if given, else the default.
  if (walletId && _wallets.has(walletId)) _provider = _wallets.get(walletId)!.provider
  if (!_provider) {
    return { ok: false, error: 'No browser wallet found (install one)' }
  }

  try {
    const accounts = await _provider.request({ method: 'eth_requestAccounts' }) as string[]
    if (!accounts || !accounts.length) {
      return { ok: false, error: 'No account authorized' }
    }
    const chainId = await _provider.request({ method: 'eth_chainId' }) as string
    const address = accounts[0]
    // Remember which wallet is active (reverse-lookup the provider if no id given).
    _activeId = walletId ?? [..._wallets.entries()].find(([, w]) => w.provider === _provider)?.[0] ?? 'injected'
    _notify(address)
    return { ok: true, address, chainId }
  } catch (e) {
    const err = e as { message?: string } | null
    return { ok: false, error: (err && err.message) ? err.message : 'connect rejected' }
  }
}

/** Forget the active wallet (UI disconnect). */
export function forgetWallet(): void { _activeId = null }

/**
 * Silently re-attach to an already-authorized wallet on page load — uses
 * `eth_accounts` (NO popup; returns [] if the site isn't authorized). Lets the
 * connection survive a refresh without clicking Connect again.
 */
export async function tryReconnect(walletId?: string): Promise<ConnectResult | null> {
  if (walletId && _wallets.has(walletId)) _provider = _wallets.get(walletId)!.provider
  if (!_provider) return null
  try {
    const accounts = await _provider.request({ method: 'eth_accounts' }) as string[] // no prompt
    if (!accounts || !accounts.length) return null
    const chainId = await _provider.request({ method: 'eth_chainId' }) as string
    const address = accounts[0]
    _activeId = walletId ?? [..._wallets.entries()].find(([, w]) => w.provider === _provider)?.[0] ?? 'injected'
    _notify(address)
    return { ok: true, address, chainId }
  } catch { return null }
}

// ---------------------------------------------------------------------------
// Existing helpers — unchanged API
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// On-chain balance reads (Polygon) — straight from the connected provider.
// The dashboard reflects whatever the connected wallet actually holds, so we
// read its native POL + USDC balances directly (no server, no API key).
// ---------------------------------------------------------------------------

// Polygon mainnet token contracts.
export const USDC_NATIVE = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359' // native (Circle) USDC
export const USDC_E      = '0x2791bca1f2de4661ed88a30c99a7a9449aa84174' // bridged USDC.e
const POLYGON_CHAIN_ID = '0x89'

export interface WalletBalances { pol: number; usdc: number; usdce: number; onPolygon: boolean }

function _hexToNum(hex: unknown, decimals: number): number {
  if (typeof hex !== 'string' || !hex.startsWith('0x')) return 0
  try { return Number(BigInt(hex)) / 10 ** decimals } catch { return 0 }
}

/** balanceOf(address) calldata for an ERC-20 read. */
function _balanceOfData(addr: string): string {
  return '0x70a08231000000000000000000000000' + addr.slice(2).toLowerCase()
}

/**
 * Read the connected wallet's POL + USDC (native and .e) balances on Polygon.
 * Reads directly through the injected provider, so it works with zero server
 * credentials. Returns zeros (and onPolygon:false) if the wallet is on the
 * wrong network or any call fails.
 */
export async function getWalletBalances(address: string): Promise<WalletBalances> {
  const empty: WalletBalances = { pol: 0, usdc: 0, usdce: 0, onPolygon: false }
  if (!_provider || !address) return empty

  try {
    const chainId = await _provider.request({ method: 'eth_chainId' }) as string
    const onPolygon = chainId === POLYGON_CHAIN_ID
    if (!onPolygon) return { ...empty, onPolygon: false }

    const [polHex, usdcHex, usdceHex] = await Promise.all([
      _provider.request({ method: 'eth_getBalance', params: [address, 'latest'] }),
      _provider.request({ method: 'eth_call', params: [{ to: USDC_NATIVE, data: _balanceOfData(address) }, 'latest'] }),
      _provider.request({ method: 'eth_call', params: [{ to: USDC_E, data: _balanceOfData(address) }, 'latest'] }),
    ])
    return {
      pol:   _hexToNum(polHex, 18),
      usdc:  _hexToNum(usdcHex, 6),
      usdce: _hexToNum(usdceHex, 6),
      onPolygon: true,
    }
  } catch {
    return empty
  }
}

// ---------------------------------------------------------------------------
// Outbound transfers — fund the app's trading wallet straight from MetaMask.
// These prompt the connected wallet (eth_sendTransaction) — funds move from the
// user's wallet, signed in the extension. No server, no stored key.
// ---------------------------------------------------------------------------

export type TxResult = { ok: true; hash: string } | { ok: false; error: string }

function _toHexWei(n: bigint): string { return '0x' + n.toString(16) }
function _pad32(hexNoPrefix: string): string { return hexNoPrefix.padStart(64, '0') }
function _errMsg(e: unknown): string {
  const m = (e as { message?: string } | null)?.message
  return m ? m : 'transaction rejected'
}

/** Send native POL (gas seed) from the connected wallet to `to`. `pol` in whole POL. */
export async function sendNativePol(to: string, pol: number, from?: string): Promise<TxResult> {
  if (!_provider) return { ok: false, error: 'No wallet connected' }
  const sender = from ?? _currentAddress
  if (!sender) return { ok: false, error: 'Wallet not connected' }
  try {
    const wei = BigInt(Math.round(pol * 1e18))
    const hash = await _provider.request({
      method: 'eth_sendTransaction',
      params: [{ from: sender, to, value: _toHexWei(wei) }],
    }) as string
    return { ok: true, hash }
  } catch (e) { return { ok: false, error: _errMsg(e) } }
}

/** Send an arbitrary prepared transaction (e.g. a 0x swap) via the connected wallet. */
export async function sendTransaction(tx: { to: string; data?: string; value?: string }, from?: string): Promise<TxResult> {
  if (!_provider) return { ok: false, error: 'No wallet connected' }
  const sender = from ?? _currentAddress
  if (!sender) return { ok: false, error: 'Wallet not connected' }
  try {
    const params: Record<string, string> = { from: sender, to: tx.to }
    if (tx.data) params['data'] = tx.data
    if (tx.value && tx.value !== '0') params['value'] = '0x' + BigInt(tx.value).toString(16)
    const hash = await _provider.request({ method: 'eth_sendTransaction', params: [params] }) as string
    return { ok: true, hash }
  } catch (e) { return { ok: false, error: _errMsg(e) } }
}

/** Approve `spender` to pull a token (MAX) — used before a 0x swap pulls the sell token. */
export async function approveErc20(token: string, spender: string, from?: string): Promise<TxResult> {
  if (!_provider) return { ok: false, error: 'No wallet connected' }
  const sender = from ?? _currentAddress
  if (!sender) return { ok: false, error: 'Wallet not connected' }
  try {
    const data = '0x095ea7b3' + _pad32(spender.slice(2).toLowerCase()) + 'f'.repeat(64)
    const hash = await _provider.request({ method: 'eth_sendTransaction', params: [{ from: sender, to: token, data }] }) as string
    return { ok: true, hash }
  } catch (e) { return { ok: false, error: _errMsg(e) } }
}

/** Send `amount6` of a 6-decimal ERC-20 (USDC / USDC.e) from the wallet to `to`. */
export async function sendErc20(token: string, to: string, amount6: number, from?: string): Promise<TxResult> {
  if (!_provider) return { ok: false, error: 'No wallet connected' }
  const sender = from ?? _currentAddress
  if (!sender) return { ok: false, error: 'Wallet not connected' }
  try {
    const micro = BigInt(Math.round(amount6 * 1e6))
    // transfer(address,uint256) selector + padded args
    const data = '0xa9059cbb' + _pad32(to.slice(2).toLowerCase()) + _pad32(micro.toString(16))
    const hash = await _provider.request({
      method: 'eth_sendTransaction',
      params: [{ from: sender, to: token, data }],
    }) as string
    return { ok: true, hash }
  } catch (e) { return { ok: false, error: _errMsg(e) } }
}

/**
 * Make sure the connected wallet is on Polygon — switch automatically (adding the
 * chain if the wallet doesn't know it). Returns true if we end up on Polygon.
 * Beats nagging the user to switch by hand.
 */
export async function ensurePolygon(): Promise<boolean> {
  if (!_provider) return false
  try {
    const cid = await _provider.request({ method: 'eth_chainId' }) as string
    if (cid === POLYGON_CHAIN_ID) return true
    try {
      await _provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: POLYGON_CHAIN_ID }] })
      return true
    } catch (e) {
      if ((e as { code?: number } | null)?.code === 4902) {
        await _provider.request({
          method: 'wallet_addEthereumChain',
          params: [{
            chainId: POLYGON_CHAIN_ID, chainName: 'Polygon',
            nativeCurrency: { name: 'POL', symbol: 'POL', decimals: 18 },
            rpcUrls: ['https://polygon-rpc.com'], blockExplorerUrls: ['https://polygonscan.com'],
          }],
        })
        return true
      }
      return false
    }
  } catch { return false }
}

/** The active EIP-1193 provider (the connected wallet) — for wrapping in ethers. */
export function getEip1193(): Eip1193Provider | null {
  return _provider
}

/** setApprovalForAll(operator,true) on an ERC-1155 (CTF) — for enabling EOA trading. */
export async function setApprovalForAll(ctf: string, operator: string, from?: string): Promise<TxResult> {
  if (!_provider) return { ok: false, error: 'No wallet connected' }
  const sender = from ?? _currentAddress
  if (!sender) return { ok: false, error: 'Wallet not connected' }
  try {
    // setApprovalForAll(address,bool) selector 0xa22cb465 + padded operator + true
    const data = '0xa22cb465' + _pad32(operator.slice(2).toLowerCase()) + _pad32('1')
    const hash = await _provider.request({ method: 'eth_sendTransaction', params: [{ from: sender, to: ctf, data }] }) as string
    return { ok: true, hash }
  } catch (e) { return { ok: false, error: _errMsg(e) } }
}

/**
 * Subscribe to address changes (account switch / disconnect).
 * Returns an unsubscribe function.
 */
// Register the provider's accountsChanged handler exactly once (not per
// subscriber) — otherwise every subscribe leaked another listener (the
// "11 listeners" warning) and fanned each event out N× into _notify.
let _accountsHooked = false
function _hookAccounts(): void {
  if (_accountsHooked || !_provider?.on) return
  _accountsHooked = true
  _provider.on('accountsChanged', (accounts: unknown) => {
    const list = accounts as string[]
    _notify(list[0] ?? null)
  })
}

export function onAddressChange(cb: AddressChangeCallback): () => void {
  _listeners.add(cb)
  _hookAccounts()
  return () => { _listeners.delete(cb) }
}
