/**
 * Per-market result history — persisted to <TC_DATA_DIR>/window_history.json
 * (default ~/.triplecrypt).
 *
 * Polymarket's Gamma API only keeps the current + most-recent window queryable
 * by slug (older window markets are archived), so the "last 3" results for a
 * market can't be fetched in one shot. Instead we accumulate them: each poll
 * merges whatever decided windows we *can* see, keyed by end timestamp, and the
 * file persists across restarts — so after the app has observed a few windows,
 * every market shows a full last-3 instantly.
 */
import fs from 'fs'
import path from 'path'
import os from 'os'

// Honour TC_DATA_DIR (see io/settings.ts) so this survives container recreates.
function dataDir(): string {
  const d = (process.env['TC_DATA_DIR'] ?? '').trim()
  return d ? d : path.join(os.homedir(), '.triplecrypt')
}

const DIR = dataDir()
const FILE = path.join(DIR, 'window_history.json')

interface Entry { t: number; w: string }      // end timestamp, winner ("UP"|"DOWN")
type Store = Record<string, Entry[]>           // slug → entries, ascending by t

let _store: Store | null = null
const KEEP = 8                                  // cap entries kept per market

function load(): Store {
  if (_store) return _store
  try { _store = JSON.parse(fs.readFileSync(FILE, 'utf8')) as Store } catch { _store = {} }
  return _store
}

/**
 * Merge freshly-seen decided windows into a market's history and return its
 * latest `n` winners, oldest → newest.
 */
export function recordResults(slug: string, seen: Array<{ t: number; w: string }>, n = 3): string[] {
  if (!slug) return []
  const store = load()
  const byT = new Map<number, string>((store[slug] ?? []).map(e => [e.t, e.w]))
  for (const { t, w } of seen) {
    if ((w === 'UP' || w === 'DOWN') && t > 0) byT.set(t, w)
  }
  const merged = [...byT.entries()]
    .sort((a, b) => a[0] - b[0])
    .slice(-KEEP)
    .map(([t, w]) => ({ t, w }))
  store[slug] = merged
  return merged.slice(-n).map(e => e.w)
}

/** Persist the in-memory store (best-effort). Call once per poll, not per slug. */
export function save(): void {
  if (!_store) return
  try {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(_store), 'utf8')
  } catch { /* best-effort */ }
}
