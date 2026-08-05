/** Font families, weights, and a snapped font-size scale (Android-style). */

export const FONT = {
  MONO: "'JetBrains Mono', ui-monospace, monospace",
  SANS: "'Inter Polymarket', Inter, sans-serif",
  // Countdowns / clocks / time ranges — digital-timer look.
  TIME: "'Orbitron', 'JetBrains Mono', ui-monospace, monospace",
} as const

export const FW = {
  SEMI:  600,
  BOLD:  700,
  XBOLD: 800,
  BLACK: 900,
} as const

// Font-size scale. Inline rem/px sizes snap to the nearest step (the comment on
// each token lists the raw values it absorbs).
export const FS = {
  MICRO: '0.5rem',   // 8px
  NANO:  '0.56rem',  // 9px · 0.54 0.55 0.56 0.58
  XXS:   '0.62rem',  // 10px · 0.6 0.62 0.65
  XS:    '0.7rem',   // 11px · 0.66 0.68 0.7
  SM:    '0.74rem',  // 12px · 0.72 0.74
  BASE:  '0.78rem',  // 13px · 0.76 0.78
  MD:    '0.85rem',  // 0.8 0.82 0.85
  LG:    '0.95rem',  // 0.9 0.92 0.95
  XL:    '1.05rem',  // 1.0 1.05
  H3:    '1.2rem',   // 1.1 1.18 1.2
  H2:    '1.4rem',   // 1.25 1.4
  H1:    '1.55rem',  // 1.5 1.55
  DISPLAY: '3rem',   // countdown
} as const
