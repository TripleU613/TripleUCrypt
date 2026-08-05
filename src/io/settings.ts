/**
 * Settings persistence IO layer.
 * Reads/writes <TC_DATA_DIR>/settings.json (default ~/.triplecrypt) for prefs.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'

// Must honour TC_DATA_DIR like banking/ledger.ts does: in Docker that env var
// points at the mounted volume, and hardcoding ~/.triplecrypt here meant
// settings silently did NOT persist across container recreates.
function dataDir(): string {
  const d = (process.env['TC_DATA_DIR'] ?? '').trim()
  return d ? d : path.join(os.homedir(), '.triplecrypt')
}

const SETTINGS_DIR = dataDir()
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'settings.json')

export type SettingsShape = {
  // chart / display
  interval?: string
  mode?: string
  theme?: string
  chart_asset?: string
  // trading config
  practice?: boolean
  buy_mode?: string
  buy_side?: string
  trade_size?: string
  limit_price?: string
  presets?: number[]
  // wallet / mode
  sign_mode?: string       // 'instant' (server/.env) | 'wallet' (browser)
  send_currency?: string
  swap_from?: string
  swap_to?: string
  last_wallet?: string     // last connected browser-wallet address (hint only)
}

export function loadSettings(): SettingsShape {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE, 'utf8')
    return JSON.parse(raw) as SettingsShape
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    if (err?.code === 'ENOENT') return {}
    return {}
  }
}

// Debounced, non-blocking persistence. High-frequency actions (every keystroke
// on size/amount inputs, every side/mode toggle) call saveSettings; a synchronous
// pretty-printed writeFileSync on each one blocked the event loop and caused
// per-press lag. We instead coalesce rapid saves into one trailing async write.
const WRITE_DEBOUNCE_MS = 800
let _pending: SettingsShape | null = null
let _timer: ReturnType<typeof setTimeout> | null = null

async function _flush(): Promise<void> {
  _timer = null
  const s = _pending
  _pending = null
  if (!s) return
  try {
    await fs.promises.mkdir(SETTINGS_DIR, { recursive: true })
    // Compact JSON — no pretty-print; this is a machine-read file.
    await fs.promises.writeFile(SETTINGS_FILE, JSON.stringify(s), 'utf8')
  } catch {
    // ignore write errors — settings are best-effort
  }
}

export function saveSettings(s: SettingsShape): void {
  // Keep the latest snapshot; coalesce a burst of calls into a single write.
  _pending = s
  if (_timer) return
  _timer = setTimeout(() => { void _flush() }, WRITE_DEBOUNCE_MS)
  // Don't let the timer keep the process alive on shutdown.
  if (typeof _timer.unref === 'function') _timer.unref()
}

// Persist immediately, synchronously — for process-exit paths where the
// debounced trailing write would otherwise be lost.
export function flushSettingsSync(): void {
  if (_timer) { clearTimeout(_timer); _timer = null }
  const s = _pending
  _pending = null
  if (!s) return
  try {
    if (!fs.existsSync(SETTINGS_DIR)) fs.mkdirSync(SETTINGS_DIR, { recursive: true })
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s), 'utf8')
  } catch {
    // best-effort
  }
}
