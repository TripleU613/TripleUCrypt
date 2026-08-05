/**
 * reconcile — trust nothing about a real-money fill until the position proves it.
 *
 * WHY
 * ---
 * The buy path used to report a fill purely from the CLOB's response ("Bought
 * 12.34 UP @ 57c") and then fire a positions refresh WITHOUT ever checking that
 * the refresh agreed. If a fill is reported but the position never materialises
 * -- a partially-matched order the response rounds up, a token id mismatch, an
 * order that matched against a market resolving in the same instant, or simply
 * an API that lied -- the user saw a success toast and owned nothing. That is
 * the "a penny went missing" class of bug, and silence is the worst possible
 * behaviour for it.
 *
 * So after any live fill we independently confirm the position exists and is at
 * least the size we were told we bought. If it does not confirm, we say so
 * loudly and record it as unreconciled rather than pretending it worked.
 *
 * DESIGN NOTES
 * ------------
 * * Absolute, not differential: after buying N shares the holding must be >= N
 *   (any prior holding only adds). That avoids a pre-trade balance read, which
 *   would add latency to the signing path on a 5-minute scalping product.
 * * Retries with a short backoff, because position indexing legitimately lags a
 *   fill by a second or two. A mismatch is only reported after the lag window.
 * * Never throws, and never blocks or reverses an order. The trade has already
 *   happened; this only decides what we TELL the user and what we record.
 * * Practice mode is settled locally and instantly, so callers skip it.
 */

/** Tolerance on share comparison — CLOB sizes are 4dp; allow float dust. */
const EPS = 1e-3

export interface ReconcileOutcome {
  /** The holding confirmed at >= the expected size. */
  ok: boolean
  expected: number
  /** Best observed holding; null if the position could never be read. */
  observed: number | null
  attempts: number
  /** Set when the holding could not be read at all (API down) rather than
   *  read and found short — those are different problems. */
  unreadable: boolean
}

export interface ReconcileOptions {
  /** Reads the current holding for the token, or null if it can't be read. */
  readHeld: () => Promise<number | null>
  /** Shares the fill claimed. */
  expected: number
  /** Delays between attempts (ms). Length = max attempts. */
  delaysMs?: number[]
  /** Injected for tests. */
  sleep?: (ms: number) => Promise<void>
}

const DEFAULT_DELAYS = [1_500, 3_000, 6_000]

const realSleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

/**
 * Poll the holding until it is at least `expected`, or the attempts run out.
 * Returns what was seen — the caller decides how to surface it.
 */
export async function reconcileHolding(opts: ReconcileOptions): Promise<ReconcileOutcome> {
  const delays = opts.delaysMs ?? DEFAULT_DELAYS
  const sleep = opts.sleep ?? realSleep
  const expected = opts.expected

  // Nothing meaningful to confirm.
  if (!(expected > 0)) {
    return { ok: true, expected, observed: null, attempts: 0, unreadable: false }
  }

  let best: number | null = null
  let attempts = 0

  for (let i = 0; i < delays.length; i++) {
    // Position indexing lags the fill, so wait before the first look too.
    await sleep(delays[i] as number)
    attempts++

    let held: number | null = null
    try {
      held = await opts.readHeld()
    } catch {
      held = null              // treat a throw as unreadable, not as short
    }

    if (held != null && (best == null || held > best)) best = held
    if (held != null && held + EPS >= expected) {
      return { ok: true, expected, observed: held, attempts, unreadable: false }
    }
  }

  return {
    ok: false,
    expected,
    observed: best,
    attempts,
    unreadable: best == null,
  }
}

/** Human-readable explanation for a failed reconcile. Kept here so the wording
 *  is consistent between the toast and the audit record. */
export function describeMismatch(o: ReconcileOutcome): string {
  if (o.unreadable) {
    return `Filled, but the position could not be verified (positions unreadable). Check Polymarket before trading again.`
  }
  return `Filled ${o.expected.toFixed(2)} shares but only ${(o.observed ?? 0).toFixed(2)} confirmed. Check Polymarket before trading again.`
}
