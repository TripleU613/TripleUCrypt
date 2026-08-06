/**
 * Chart camera math for the LINE / PROBABILITY modes of EChart.
 *
 * These live outside the component because they are the whole reason the live
 * curve used to WARP instead of MOVE, and they need to be testable without a
 * canvas or a DOM.
 *
 * The rule both helpers exist to enforce: between visual "jumps" the mapping
 * from (t, value) to (x, y) must be IDENTICAL frame to frame apart from the
 * clock. A transform that eases toward a continuously moving target can never
 * be identical frame to frame, so every point drifts a little every tick — that
 * is the "crooked up / crooked down" re-shaping. Instead we make the transform a
 * STEP FUNCTION: it is chosen from a coarse ladder, held by hysteresis, and only
 * ever changes in discrete jumps (which the caller may ease across).
 */

// ── Horizontal: the visible time span ────────────────────────────────────────

/**
 * Time-span rungs, ms. The x window is ALWAYS exactly one of these, so
 * xMin = xMax - win with a constant win, so every point travels left at the
 * same px/ms — rigid translation. (The old code used `span0 + 4000`, a span
 * that grew every frame, which squeezed every point toward x=0.)
 *
 * The top rung doubles as the old WINDOW cap: past it, points scroll off the
 * left edge instead of the span widening.
 */
export const WIN_RUNGS = [20000, 30000, 45000, 60000, 90000]

/**
 * Pick the span rung for a buffer that covers `span` ms, given the rung already
 * in use. Monotone: steps UP when the data outgrows the current rung and NEVER
 * back down, because stepping down would re-squeeze the curve — exactly the bug.
 * (A new betting window no longer resets this; only an asset/mode change does,
 * by dropping the stored rung.)
 */
export function pickWindowRung(span: number, cur?: number | null): number {
  let i = 0
  if (cur != null && isFinite(cur) && cur > 0) {
    // Snap a stored value onto the ladder (smallest rung >= it) so a stale or
    // hand-edited number can't wedge the loop below.
    while (i < WIN_RUNGS.length - 1 && WIN_RUNGS[i] < cur) i++
  }
  const s = isFinite(span) ? span : 0
  while (i < WIN_RUNGS.length - 1 && s >= WIN_RUNGS[i]) i++
  return WIN_RUNGS[i]
}

// ── Vertical: quantized range + center, with hysteresis ──────────────────────

/**
 * Mantissa ladder for the y range. Finer than the usual 1/2/5 so a range step
 * is a modest jump (max ratio 1.67) rather than a 2.5x slam, while still being
 * coarse enough that ordinary price wandering never changes rung.
 */
const MANT = [1, 1.5, 2, 3, 5, 7, 10]

/** Smallest ladder value >= v (v > 0). */
export function niceRangeUp(v: number): number {
  if (!(v > 0) || !isFinite(v)) return 1e-9
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  const m = v / p
  for (const c of MANT) { if (m <= c * (1 + 1e-9)) return c * p }
  return 10 * p
}

// Fill/hysteresis constants. Derivation matters, so: on a (re)fit the data
// occupies at most FILL of the height, i.e. a half-span of FILL/2 = 0.30·range.
// We refit when it grows past GROW (0.72) or has shrunk under SHRINK (0.30) —
// and SHRINK sits below the tightest possible post-fit fill (FILL / 1.67 =
// 0.36) so a refit can never immediately re-trigger the opposite refit.
// The pan deadzone half-width DEAD must be >= post-fit half-span (0.30) plus
// the worst center-quantization error (half a grid cell = 1/16 = 0.0625), i.e.
// >= 0.3625; 0.45 leaves margin and still guarantees containment (< 0.5).
const FILL   = 0.60
const GROW   = 0.72
const SHRINK = 0.30
const DEAD   = 0.45
const GRID_N = 8      // center snaps to multiples of range / GRID_N

export interface CamBand { lo: number; hi: number }
export interface CamBounds { min: number; max: number }

function place(dataLo: number, dataHi: number, range: number, bounds?: CamBounds): CamBand {
  const dataCenter = (dataLo + dataHi) / 2
  const step = range / GRID_N
  let center = Math.round(dataCenter / step) * step
  // Quantizing the center must never push data off-screen; fall back to the raw
  // center in the (post-refit impossible, defensively handled) tight case.
  if (dataHi > center + range / 2 || dataLo < center - range / 2) center = dataCenter
  let lo = center - range / 2
  let hi = center + range / 2
  if (bounds) {
    const span = bounds.max - bounds.min
    if (range >= span) { lo = bounds.min; hi = bounds.max }
    else if (lo < bounds.min) { lo = bounds.min; hi = bounds.min + range }
    else if (hi > bounds.max) { hi = bounds.max; lo = bounds.max - range }
  }
  return { lo, hi }
}

/**
 * The y camera: a step function of the visible data bounds.
 *
 * Returns the band to show. Given the SAME data extremes it returns the SAME
 * band (idempotent), and small data movement inside the deadzone returns `cur`
 * unchanged — that stillness is the point. `bounds` clamps the band into a
 * fixed domain (0–100 for probability) by SLIDING it, never by cropping it, so
 * the range stays quantized and the curve stays rigid at the domain edges.
 *
 * `cur` must be the previous TARGET band, not an eased/displayed one, or the
 * hysteresis tests drift with the easing.
 */
export function quantizeCam(
  dataLo: number,
  dataHi: number,
  cur?: CamBand | null,
  bounds?: CamBounds,
): CamBand {
  let lo = dataLo, hi = dataHi
  if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 0 }
  if (hi < lo) { const t = lo; lo = hi; hi = t }
  let dataRange = hi - lo
  if (!(dataRange > 0)) dataRange = Math.max(Math.abs(hi) * 1e-4, 1e-9)
  const dataCenter = (lo + hi) / 2

  const fit = () => place(lo, hi, niceRangeUp(dataRange / FILL), bounds)
  if (!cur || !isFinite(cur.lo) || !isFinite(cur.hi) || !(cur.hi > cur.lo)) return fit()

  const range = cur.hi - cur.lo
  const center = (cur.lo + cur.hi) / 2
  // Drastic change (asset switch, rollover onto a different scale): re-seed.
  if (dataRange > range * 4 || Math.abs(dataCenter - center) > range * 4) return fit()
  // Range rung: refit only outside the hysteresis band.
  if (dataRange > range * GROW || dataRange < range * SHRINK) return fit()
  // Range held. Pan only when the data pushes out of the deadzone — and note
  // this is symmetric: a new HIGH and a new LOW are handled the same way. The
  // old `else if` pinned the data's top to a fixed screen line, so every new
  // high shoved the whole curve down while new lows did nothing.
  const inner = range * DEAD
  if (hi > center + inner || lo < center - inner) return place(lo, hi, range, bounds)
  return { lo: cur.lo, hi: cur.hi }
}

// ── Decimation bucket ────────────────────────────────────────────────────────

const BUCKET_MS = [50, 100, 200, 250, 500, 1000, 2000, 5000, 10000, 30000]

/**
 * Bucket width for drawing-point decimation. Buckets are absolute (multiples of
 * the epoch), so a point keeps its bucket as the window scrolls; index-strided
 * decimation instead re-picks which points survive every tick, which makes the
 * curve shimmer between two slightly different shapes.
 */
export function decimateBucketMs(span: number, maxPts: number): number {
  if (!(span > 0) || !(maxPts > 0)) return BUCKET_MS[0]
  const want = span / maxPts
  for (const b of BUCKET_MS) { if (b >= want) return b }
  return BUCKET_MS[BUCKET_MS.length - 1]
}
