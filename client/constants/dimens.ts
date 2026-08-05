/** Spacing, border-radius, and dimension tokens. */

export const D = {
  // ── Border radius ─────────────────────────────────────────────────────────
  R_XS:   '4px',
  R_SM:   '6px',
  R_BTN:  '8px',   // buttons, icon containers
  R_CTRL: '9px',   // segmented controls, inputs
  R_CARD: '10px',  // cards, panels
  R_PILL: '999px', // badge pills

  // ── Gap / grid spacing ────────────────────────────────────────────────────
  GAP_XS: '2px',
  GAP_SM: '4px',
  GAP:    '6px',
  GAP_MD: '8px',
  GAP_LG: '12px',
  GAP_XL: '16px',

  // ── Padding shorthand ─────────────────────────────────────────────────────
  PAD_XS: '4px',
  PAD_SM: '6px',
  PAD:    '8px',
  PAD_MD: '12px',
  PAD_LG: '16px',
  PAD_BTN: '6px',            // square icon button pad
  PAD_CHIP: '2px 8px',       // pill/chip labels

  // ── Fixed component heights ───────────────────────────────────────────────
  H_NAV:    '46px',
  H_TF_BAR: '38px',
  H_CTA:    '48px',

  // ── Icon sizes (numeric, for SVG width/height) ────────────────────────────
  ICO_SM:   16,
  ICO_MD:   18,
  ICO_LG:   22,

  // ── Nav / brand ───────────────────────────────────────────────────────────
  BRAND_ICON: '30px',
} as const

// Spacing scale (gaps / paddings / offsets). Inline px snap to the nearest step
// (comment lists absorbed raw values). Use for margins, gaps, padding.
export const SP = {
  NONE: '0px',
  HAIR: '1px',   // hairline borders
  XXS:  '2px',   // 2 3
  XS:   '4px',   // 4 5
  SM:   '6px',   // 6 7
  MD:   '8px',   // 8 9
  LG:   '10px',  // 10 11
  XL:   '12px',  // 12 13
  XXL:  '16px',  // 14 15 16 18
  H3:   '20px',  // 20
  H2:   '24px',  // 24
} as const

// Fixed component sizes (heights / square dims) — kept exact, not snapped, since
// these are deliberate element dimensions rather than spacing.
export const SZ = {
  S24: '24px', S28: '28px', S30: '30px', S34: '34px', S36: '36px',
  S40: '40px', S44: '44px', S46: '46px', S48: '48px', S52: '52px',
  S54: '54px', S60: '60px', S64: '64px', S70: '70px',
} as const
