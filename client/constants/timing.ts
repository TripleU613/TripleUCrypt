/** Animation, transition, and polling timing constants (all in ms). */

export const MS = {
  // ── Gaming mode: NumberFlow flip durations ────────────────────────────────
  FLIP_TURBO:    350,
  FLIP_SMOOTH:   450,
  FLIP_ECO:      600,
  FLIP_SURVIVAL: 800,

  // ── Gaming mode: EChart intro sweep durations ─────────────────────────────
  ANIM_TURBO:    300,
  ANIM_SMOOTH:   200,
  ANIM_ECO:      150,
  ANIM_SURVIVAL: 0,

  // ── UI micro-interactions ─────────────────────────────────────────────────
  TRANSITION_QUICK: 120,   // hover/active states
  TRANSITION:       160,   // standard state change
  THEME:            340,   // light↔dark crossfade

  // ── Boot / reveal ─────────────────────────────────────────────────────────
  // decrypt (always) → bounce/"loading" (while waiting) → explode (the instant
  // the app reports ready). The explosion fires immediately on ready — it's just
  // an overlay — so the only floor is finishing the decrypt intro.
  // NOTE: BOOT_SCRAMBLE is NOT the floor it looks like. Measured, anime's
  // scrambleText finishes in ~400ms (letters ready ~613ms) regardless of this
  // number, so tuning it does nothing. The real floor was BOOT_LOADING_MIN +
  // BOOT_BURST, which held the app behind an opaque curtain for ~2.6s after it
  // was already sharp and ~4.0s before the overlay unmounted -- while every
  // field the reveal waits on arrives in the FIRST SSE snapshot, ~9ms after the
  // GET. The boot was never slow; it was deliberately held.
  BOOT_SCRAMBLE:    2_500,  // decrypt decode duration (self-limiting, see above)
  BOOT_LOADING_MIN:   700,  // min beat for the "loading" bounce (was 2_000)
  BOOT_BURST:       1_300,  // explosion/unblur duration before the overlay unmounts
  // Grace wait for non-essential streams. Was 9_000, which meant one failing
  // sub-fetch pinned the user on a bouncing wordmark for nine seconds.
  BOOT_FALLBACK:    2_500,

  // ── Connection / dead-state ───────────────────────────────────────────────
  DEAD_MS:    30_000,  // clock_tick staleness threshold (tolerant of reconnects)
  FPS_WINDOW:  2_000,  // rAF FPS sample window
  CLOCK_POLL:  1_000,  // dead-state watchdog poll
  STATUS_TTL:  3_000,  // auto-clear trading status bar
  STATUS_LONG: 5_000,  // longer status (order errors)
} as const
