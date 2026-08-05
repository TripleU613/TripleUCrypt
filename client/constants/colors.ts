/**
 * Brand color palette — allowed families: black/white, grey, orange, red, green.
 * NO BLUE: the former blue tokens (BLUE/TEAL/CYAN/INDIGO) are kept by name for
 * compatibility but all point at the orange family now.
 * CSS-variable tokens (var(--tc-*)) live in theme.ts and are not repeated here.
 */

export const C = {
  // ── UP / profit (green) ───────────────────────────────────────────────────
  // NOTE: the base accent hues resolve through theme-aware CSS vars so that any
  // inline `color:` / `stroke` / `fill` usage adapts per theme — vivid neon in
  // dark, a deeper non-buzzing tone in light. The vars resolve to the exact
  // legacy hexes in dark (defined in theme.ts :root), so dark is unchanged.
  // Canvas code must keep using the *_RGB strings (vivid candles) — never the
  // var() forms — and hex-concat (`${C.X}44`) must use the *_RGB rgba() helpers.
  GREEN:         'var(--tc-green)',
  GREEN_DK:      '#15803d',
  GREEN_TEXT:    '#06281a',   // legible text on solid green fill
  GREEN_RGB:     '34,212,123', // for canvas rgba() strings
  GREEN_BORDER:  'rgba(34,212,123,0.5)',
  GREEN_BG:      'rgba(34,212,123,0.12)',
  GREEN_TINT:    'rgba(34,212,123,0.10)',
  GREEN_TINT_HI: 'rgba(34,212,123,0.16)',

  // ── DOWN / loss (red) ─────────────────────────────────────────────────────
  RED:           'var(--tc-red)',
  RED_DK:        '#991b1b',
  RED_TEXT:      '#1a0606',
  RED_RGB:       '239,68,68',  // for canvas rgba() strings
  RED_BORDER:    'rgba(239,68,68,0.5)',
  RED_BG:        'rgba(239,68,68,0.12)',
  RED_TINT:      'rgba(239,68,68,0.10)',
  RED_TINT_HI:   'rgba(239,68,68,0.16)',

  // ── 1-tap / amber / gold (orange family) ──────────────────────────────────
  GOLD:          'var(--tc-gold)',
  GOLD_BORDER:   'rgba(245,158,11,0.5)',
  GOLD_BG:       'rgba(245,158,11,0.12)',
  GOLD_TINT:     'rgba(245,158,11,0.10)',

  // ── Market mode / probability (was blue → orange) ────────────────────────
  BLUE:          'var(--tc-blue)',
  BLUE_BORDER:   'rgba(245,158,11,0.5)',
  BLUE_BG:       'rgba(245,158,11,0.12)',

  // ── Limit mode (was blue → orange) ────────────────────────────────────────
  TEAL:          'var(--tc-gold)',
  TEAL_BORDER:   'rgba(245,158,11,0.5)',
  TEAL_BG:       'rgba(245,158,11,0.12)',

  // ── Practice mode (grey) ─────────────────────────────────────────────────
  PURPLE:        '#6b7280',
  PURPLE_BORDER: 'rgba(107,114,128,0.5)',
  PURPLE_BG:     'rgba(107,114,128,0.12)',

  // ── Wallet accent (was light blue → orange) ───────────────────────────────
  CYAN:          'var(--tc-gold)',
  CYAN_BORDER:   'rgba(245,158,11,0.5)',
  CYAN_BG:       'rgba(245,158,11,0.12)',

  // ── Accent (was blue → orange) ────────────────────────────────────────────
  INDIGO:        'var(--tc-gold)',
  INDIGO_BORDER: 'rgba(245,158,11,0.5)',
  INDIGO_BG:     'rgba(245,158,11,0.12)',

  // ── Neutral grays / foreground — theme-aware (flip in light mode) ──────────
  // These resolve through CSS vars so inline `color:`/icon strokes adapt to the
  // active theme. (WHITE = the strong foreground, not literal white.)
  DIM:           'var(--tc-dim)',
  DIM2:          'var(--tc-dim2)',
  DIM3:          'var(--tc-dim3)',
  WHITE:         'var(--tc-text-strong)',

  // ── Coin brand colors ─────────────────────────────────────────────────────
  BTC:           'var(--tc-btc)',
  ETH:           '#6b7280',   // was brand blue → grey (no blue in the system)
  SOL:           '#6b7280',
} as const
