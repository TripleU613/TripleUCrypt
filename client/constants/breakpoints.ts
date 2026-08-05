/** Responsive breakpoints in px — mirrors Python nav.py rx.breakpoints. */

export const BP = {
  TABLET:  768,   // stats-strip core (CASH / SPEND / PROFIT / ACC)
  DESKTOP: 992,   // + WINS / LOSS
  WIDE:    1280,  // + WALLET / OUT; full stats strip
} as const
