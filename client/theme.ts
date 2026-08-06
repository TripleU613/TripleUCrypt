/**
 * Design tokens — injected as a <style> tag at boot.
 * Wrapping CSS in TypeScript keeps the repo .ts/.tsx only.
 * To edit styles, change the CSS string below.
 */

const CSS = `
/* ── Font face ──────────────────────────────────────────────── */
@font-face {
  font-family: 'Inter Polymarket';
  src: url('/fonts/inter-polymarket.ttf') format('truetype-variations');
  font-weight: 100 900;
  font-style: normal;
  font-display: swap;
}

/* Time/countdown display face — geometric, "digital timer" look (Orbitron). */
@font-face {
  font-family: 'Orbitron';
  src: url('/fonts/orbitron.ttf') format('truetype-variations');
  font-weight: 400 900;
  font-style: normal;
  font-display: swap;
}

/* ── Global reset ───────────────────────────────────────────── */
*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
}

/* ── Dark theme tokens (default) ────────────────────────────── */
:root {
  /* surfaces */
  /* NOTE: --tc-bg is ALSO inlined in client/index.html's critical <style> so the
     page has a background before this JS-injected CSS exists. Change both. */
  --tc-bg:          #080808;
  --tc-bg-deep:     #000000;
  --tc-card:        #0f0f0f;
  --tc-card-alt:    #0d0d0d;
  --tc-panel:       #111111;
  --tc-hover:       #161616;
  --tc-active:      #1a1a1a;
  --tc-border:      #1c1c1c;
  --tc-border-hi:   #2a2a2a;

  /* text */
  --tc-text:        #e8e8e8;
  --tc-text-strong: #ffffff;
  --tc-white:       var(--tc-text-strong);  /* strong foreground (theme-aware) */
  --tc-text-2:      #b0b0b0;
  --tc-dim:         #404040;
  --tc-dim2:        #606060;
  --tc-dim3:        #808080;

  /* chart */
  --tc-chart-bg:    #0f0f0f;
  --tc-chart-grid:  #1c1c1c;
  --tc-chart-text:  #5e5e5e;

  /* misc surfaces */
  --tc-scrim:       rgba(0,0,0,0.45);
  --tc-glass:       rgba(15,15,15,0.92);
  --tc-glass-dim:   rgba(13,13,13,0.66);
  --tc-tooltip-bg:  rgba(40,40,40,0.95);
  --tc-white-05:    rgba(255,255,255,0.05);
  --tc-white-07:    rgba(255,255,255,0.07);
  --tc-white-25:    rgba(255,255,255,0.25);
  --tc-scrollbar:   rgba(184,184,184,0.32);
  --tc-light-surf:  #cdd2da;

  /* elevation */
  --tc-elev-1: 0 1px 0 0 rgba(255,255,255,0.04) inset, 0 2px 8px rgba(0,0,0,0.55);
  --tc-elev-2: 0 1px 0 0 rgba(255,255,255,0.05) inset, 0 8px 28px rgba(0,0,0,0.65);
  --tc-elev-3: 0 1px 0 0 rgba(255,255,255,0.06) inset, 0 18px 50px rgba(0,0,0,0.72);

  /* accent glows (emissive in dark) */
  --tc-glow-up:    0 0 0 1px rgba(34,212,123,0.45), 0 0 18px rgba(34,212,123,0.28), 0 0 2px rgba(34,212,123,0.5) inset;
  --tc-glow-down:  0 0 0 1px rgba(239,68,68,0.45),  0 0 18px rgba(239,68,68,0.26),  0 0 2px rgba(239,68,68,0.5) inset;
  --tc-glow-btc:   0 0 0 1px rgba(247,147,26,0.45), 0 0 18px rgba(247,147,26,0.30);
  --tc-glow-prob:  0 0 0 1px rgba(245,158,11,0.45), 0 0 18px rgba(245,158,11,0.30);
  --tc-glow-gold:  0 0 0 1px rgba(245,158,11,0.40), 0 0 16px rgba(245,158,11,0.26);
  --tc-glow-soft:  0 0 22px rgba(34,212,123,0.10);

  /* text glows */
  --tc-tglow-up:   0 0 10px rgba(34,212,123,0.35);
  --tc-tglow-down: 0 0 10px rgba(239,68,68,0.35);
  --tc-tglow-btc:  0 0 10px rgba(247,147,26,0.35);

  /* gradients */
  --tc-grad-panel:     linear-gradient(180deg, rgba(255,255,255,0.025), rgba(255,255,255,0) 42%);
  --tc-grad-card:      linear-gradient(180deg, rgba(255,255,255,0.04), rgba(255,255,255,0) 60%);
  --tc-grad-up:        linear-gradient(180deg, #2ee089, #18a861);
  --tc-grad-down:      linear-gradient(180deg, #f25555, #c93434);
  --tc-grad-up-tint:   linear-gradient(180deg, rgba(34,212,123,0.14), rgba(34,212,123,0.03));
  --tc-grad-down-tint: linear-gradient(180deg, rgba(239,68,68,0.14),  rgba(239,68,68,0.03));
  --tc-grad-border:    linear-gradient(120deg, rgba(34,212,123,0.7), rgba(245,158,11,0.0) 40%, rgba(247,147,26,0.0) 60%, rgba(34,212,123,0.7));
  --tc-grad-sheen:     linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.10) 50%, transparent 70%);

  /* accent-tinted surfaces */
  --tc-up-tint:      rgba(34,212,123,0.10);
  --tc-up-tint-hi:   rgba(34,212,123,0.16);
  --tc-down-tint:    rgba(239,68,68,0.10);
  --tc-down-tint-hi: rgba(239,68,68,0.16);

  /* glass */
  --tc-glass-bg:   rgba(16,16,18,0.62);
  --tc-glass-brd:  rgba(255,255,255,0.08);
  --tc-glass-blur: blur(10px) saturate(140%);

  /* focus rings + selection */
  --tc-ring:      0 0 0 2px var(--tc-bg), 0 0 0 4px rgba(245,158,11,0.7);
  --tc-ring-up:   0 0 0 2px var(--tc-bg), 0 0 0 4px rgba(34,212,123,0.75);
  --tc-ring-down: 0 0 0 2px var(--tc-bg), 0 0 0 4px rgba(239,68,68,0.75);
  --tc-selection-bg: rgba(34,212,123,0.28);
  --tc-selection-fg: #ffffff;

  /* page wash */
  --tc-page-wash:
    radial-gradient(900px 500px at 12% -8%, rgba(247,147,26,0.06), transparent 60%),
    radial-gradient(900px 500px at 100% 110%, rgba(245,158,11,0.06), transparent 60%);

  /* motion */
  --tc-ease: cubic-bezier(.4,0,.2,1);
  --tc-dur:  0.16s;

  /* spotlight */
  --tc-spot-ring: rgba(34,212,123,0.78);
  --tc-spot-glow: 0 0 30px rgba(34,212,123,0.14);

  /* accents — vivid/neon in dark; deepened in the light block so inline
     color/stroke usage (via C.GREEN/RED/GOLD/BTC) reads on white without buzzing */
  --tc-green:     #22d47b;
  --tc-green-dk:  #15803d;
  --tc-red:       #ef4444;
  --tc-red-dk:    #991b1b;
  --tc-gold:      #f59e0b;
  --tc-blue:      #f59e0b;
  --tc-btc:       #f7931a;
  --tc-eth:       #6b7280;
  --tc-sol:       #6b7280;

  /* layout dims */
  --tc-left-w:    320px;
  --tc-right-w:   320px;
  --tc-topbar-h:  56px;
  --tc-gap:       8px;
}

/* ── Light theme overrides ───────────────────────────────────── */
/* Light-mode design intent: soft cool off-whites (no acres of #fff), gentle
   surface hierarchy by lightness, near-black text with a blue-grey hint, and
   accents deepened so they read on white without buzzing. Glows become neutral
   elevation; tints/borders are low-alpha hairlines. */
html[data-theme="light"] {
  /* surfaces — a cool off-white system; pure #fff is reserved for the few
     elevated things (cards), panels/hover sit a touch greyer for hierarchy */
  --tc-bg:          #f4f5f7;
  --tc-bg-deep:     #eaecf0;
  --tc-card:        #fbfcfd;
  --tc-card-alt:    #ffffff;
  --tc-panel:       #eef0f3;
  --tc-hover:       #e9ebef;
  --tc-active:      #dfe2e8;
  --tc-border:      #e3e6ea;
  --tc-border-hi:   #ccd1d9;

  /* text — near-black with a blue-grey hint (not harsh #0f1115 on white);
     dimmer tiers stay clearly separated but not muddy */
  --tc-text:        #1c2230;
  --tc-text-strong: #11151f;
  --tc-text-2:      #444e60;
  --tc-dim:         #6b7480;
  --tc-dim2:        #8a929e;
  --tc-dim3:        #98a0ac;

  /* chart — keep a clean white plot with soft grid; candles stay vivid (canvas) */
  --tc-chart-bg:    #ffffff;
  --tc-chart-grid:  #e7eaee;
  --tc-chart-text:  #98a0ac;
  --tc-scrim:       rgba(28,34,48,0.32);
  --tc-glass:       rgba(251,252,253,0.94);
  --tc-glass-dim:   rgba(251,252,253,0.7);
  --tc-tooltip-bg:  rgba(251,252,253,0.97);
  --tc-white-05:    rgba(28,34,48,0.035);
  --tc-white-07:    rgba(28,34,48,0.055);
  --tc-white-25:    rgba(28,34,48,0.16);
  --tc-scrollbar:   rgba(28,34,48,0.16);
  --tc-light-surf:  #e9ebef;

  /* accents as TEXT/ICON — deeper, non-neon tones that read on white.
     (These feed C.GREEN/RED/GOLD/CYAN/BTC inline color/stroke usage.) */
  --tc-green:       #0f9d58;
  --tc-red:         #d22d2d;
  --tc-gold:        #b45309;
  --tc-blue:        #b45309;
  --tc-btc:         #c2620e;
  --tc-green-dk:    #0c7a44;
  --tc-red-dk:      #a51f1f;

  /* elevation — gentle, mostly-neutral cool-grey shadows; no heavy black */
  --tc-elev-1: 0 1px 0 0 rgba(255,255,255,0.7) inset, 0 1px 2px rgba(28,34,48,0.05), 0 1px 1px rgba(28,34,48,0.03);
  --tc-elev-2: 0 1px 0 0 rgba(255,255,255,0.7) inset, 0 4px 12px rgba(28,34,48,0.07), 0 1px 3px rgba(28,34,48,0.04);
  --tc-elev-3: 0 1px 0 0 rgba(255,255,255,0.7) inset, 0 12px 30px rgba(28,34,48,0.10), 0 3px 8px rgba(28,34,48,0.05);

  /* "glows" → soft neutral-leaning elevation with a faint accent hairline.
     No emissive colored halos in light. */
  --tc-glow-up:    0 0 0 1px rgba(15,157,88,0.30),  0 3px 10px rgba(28,34,48,0.07);
  --tc-glow-down:  0 0 0 1px rgba(210,45,45,0.30),  0 3px 10px rgba(28,34,48,0.07);
  --tc-glow-btc:   0 0 0 1px rgba(194,98,14,0.30),  0 3px 10px rgba(28,34,48,0.07);
  --tc-glow-prob:  0 0 0 1px rgba(180,83,9,0.30),   0 3px 10px rgba(28,34,48,0.07);
  --tc-glow-gold:  0 0 0 1px rgba(180,83,9,0.28),   0 3px 10px rgba(28,34,48,0.06);
  --tc-glow-soft:  0 3px 10px rgba(28,34,48,0.06);

  /* no text-shadow halos in light */
  --tc-tglow-up:   0 0 0 rgba(0,0,0,0);
  --tc-tglow-down: 0 0 0 rgba(0,0,0,0);
  --tc-tglow-btc:  0 0 0 rgba(0,0,0,0);

  --tc-grad-panel:     linear-gradient(180deg, rgba(28,34,48,0.015), rgba(28,34,48,0) 42%);
  --tc-grad-card:      linear-gradient(180deg, rgba(255,255,255,0.8), rgba(244,245,247,0.35) 60%);
  /* solid-fill gradients (e.g. buy/sell buttons) — deeper, calmer than neon */
  --tc-grad-up:        linear-gradient(180deg, #16a85f, #0e8a4c);
  --tc-grad-down:      linear-gradient(180deg, #dd3a3a, #c02626);
  /* tints/fills — desaturated + lower alpha so blocks aren't garish */
  --tc-grad-up-tint:   linear-gradient(180deg, rgba(15,157,88,0.09), rgba(15,157,88,0.015));
  --tc-grad-down-tint: linear-gradient(180deg, rgba(210,45,45,0.08),  rgba(210,45,45,0.015));
  --tc-grad-border:    linear-gradient(120deg, rgba(15,157,88,0.4), rgba(180,83,9,0) 40%, rgba(194,98,14,0) 60%, rgba(15,157,88,0.4));
  --tc-grad-sheen:     linear-gradient(110deg, transparent 30%, rgba(255,255,255,0.45) 50%, transparent 70%);

  --tc-up-tint:      rgba(15,157,88,0.08);
  --tc-up-tint-hi:   rgba(15,157,88,0.13);
  --tc-down-tint:    rgba(210,45,45,0.07);
  --tc-down-tint-hi: rgba(210,45,45,0.12);

  /* glass — higher-opacity near-white frost, hairline faint-dark border */
  --tc-glass-bg:   rgba(251,252,253,0.78);
  --tc-glass-brd:  rgba(28,34,48,0.08);
  --tc-glass-blur: blur(12px) saturate(135%);

  --tc-ring:      0 0 0 2px var(--tc-bg), 0 0 0 4px rgba(180,83,9,0.45);
  --tc-ring-up:   0 0 0 2px var(--tc-bg), 0 0 0 4px rgba(15,157,88,0.5);
  --tc-ring-down: 0 0 0 2px var(--tc-bg), 0 0 0 4px rgba(210,45,45,0.5);
  --tc-selection-bg: rgba(15,157,88,0.16);
  --tc-selection-fg: #11151f;

  /* page wash — barely-there warm tint, no glare */
  --tc-page-wash:
    radial-gradient(900px 520px at 12% -8%, rgba(194,98,14,0.035), transparent 60%),
    radial-gradient(900px 520px at 100% 110%, rgba(180,83,9,0.03), transparent 60%);

  --tc-ease: cubic-bezier(.4,0,.2,1);
  --tc-dur:  0.16s;

  --tc-spot-ring: rgba(15,157,88,0.65);
  --tc-spot-glow: 0 4px 16px rgba(28,34,48,0.12);
}

/* ── Global base styles ──────────────────────────────────────── */
html, body {
  background: var(--tc-bg);
  color: var(--tc-text);
  font-family: 'Inter Polymarket', 'Inter', 'SF Pro Display', system-ui, sans-serif;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeSpeed;
  height: 100%;
  overflow: hidden;
}

#root {
  height: 100%;
  position: relative;
  z-index: 1;
}

/* page wash — behind everything */
body::before {
  content: "";
  position: fixed;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background: var(--tc-page-wash);
}

/* ── Focus / selection ───────────────────────────────────────── */
:focus { outline: none; }
:focus-visible {
  outline: none;
  box-shadow: var(--tc-ring);
  border-radius: 8px;
}
::selection { background: var(--tc-selection-bg); color: var(--tc-selection-fg); }

/* ── Interactive transitions ────────────────────────────────── */
button, a, [role="button"], input, select, textarea, [data-tc-interactive] {
  transition:
    color var(--tc-dur) var(--tc-ease),
    background-color var(--tc-dur) var(--tc-ease),
    border-color var(--tc-dur) var(--tc-ease),
    box-shadow var(--tc-dur) var(--tc-ease),
    transform var(--tc-dur) var(--tc-ease);
}

/* ── Scrollbar ───────────────────────────────────────────────── */
* { scrollbar-width: thin; scrollbar-color: var(--tc-scrollbar) transparent; }
*::-webkit-scrollbar { width: 8px; height: 8px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb {
  background: var(--tc-scrollbar);
  border-radius: 8px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
*::-webkit-scrollbar-thumb:hover {
  background: var(--tc-border-hi);
  background-clip: padding-box;
}

/* ── Keyframes ───────────────────────────────────────────────── */
@keyframes tc-shimmer {
  0%   { background-position: -200% 0; }
  100% { background-position:  200% 0; }
}

@keyframes tc-pop {
  0%   { transform: scale(1); }
  40%  { transform: scale(1.06); }
  100% { transform: scale(1); }
}

@keyframes tc-sheen {
  0%   { background-position: -180% 0; }
  100% { background-position:  180% 0; }
}

/* Brand wordmark shimmer — the canonical GPU-only technique (Linear/Stripe
   style): a single gradient that holds a dark base with one bright crest,
   sized to 200% and panned via background-position. background-clip:text masks
   it to the letters. No JS timers, no React re-renders, no layout work. The
   ends are the same dark colour so the loop is seamless. */
@keyframes tc-wordmark-wave {
  0%   { background-position: 200% center; }
  100% { background-position: 0% center; }
}
.tc-wordmark {
  background-image: linear-gradient(
    110deg,
    #4d4d4d 0%, #4d4d4d 40%, #ededed 50%, #4d4d4d 60%, #4d4d4d 100%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  color: transparent;
  animation: tc-wordmark-wave 6s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .tc-wordmark { animation: none; -webkit-text-fill-color: var(--tc-text-strong); }
}

@keyframes tc-pulse-glow {
  0%, 100% { box-shadow: var(--tc-glow-soft); }
  50%       { box-shadow: var(--tc-glow-up); }
}

@keyframes tc-fadein {
  from { opacity: 0; transform: translateY(4px); }
  to   { opacity: 1; transform: translateY(0); }
}

@keyframes tc-toast {
  from { opacity: 0; transform: translateY(7px); }
  to   { opacity: 1; transform: translateY(0); }
}

@keyframes tc-tick {
  0%   { filter: brightness(1.9) saturate(1.35); }
  100% { filter: brightness(1)   saturate(1); }
}

@keyframes tc-urgent {
  0%, 100% { opacity: 1;    text-shadow: 0 0 12px rgba(239,68,68,0.55); }
  50%       { opacity: 0.78; text-shadow: 0 0 4px rgba(239,68,68,0.25); }
}

@keyframes tc-border-flow {
  0%   { background-position:   0% 50%; }
  100% { background-position: 200% 50%; }
}

@keyframes tc-reveal-up {
  from { opacity: 0; transform: translateY(10px); }
  to   { opacity: 1; transform: translateY(0); }
}

@keyframes tc-reveal-down {
  from { opacity: 0; transform: translateY(-8px); }
  to   { opacity: 1; transform: translateY(0); }
}

@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
@keyframes tcpulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }

@keyframes tc-cd-breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.7; } }
@keyframes tc-cd-beat {
  0%, 100% { transform: scale(1); }
  12%       { transform: scale(1.045); }
  24%       { transform: scale(1); }
}

@keyframes tc-conn-pulse {
  0%, 100% { opacity: 1;    box-shadow: 0 0 14px rgba(208,216,230,0.75); }
  50%       { opacity: 0.35; box-shadow: 0 0 4px  rgba(208,216,230,0.25); }
}

@keyframes tc-spin {
  to { transform: rotate(360deg); }
}

/* ── Utility classes ─────────────────────────────────────────── */

.tc-skel {
  background: linear-gradient(100deg,
    var(--tc-hover) 30%, var(--tc-active) 50%, var(--tc-hover) 70%);
  background-size: 200% 100%;
  animation: tc-shimmer 1.4s ease-in-out infinite;
}

.tc-hoverlift {
  transition:
    transform var(--tc-dur) var(--tc-ease),
    box-shadow var(--tc-dur) var(--tc-ease),
    border-color var(--tc-dur) var(--tc-ease),
    background-color var(--tc-dur) var(--tc-ease);
  will-change: transform;
}
.tc-hoverlift:hover  { transform: translateY(-1px); box-shadow: var(--tc-elev-2); }
.tc-hoverlift:active { transform: translateY(0) scale(0.99); }

.tc-pop { animation: tc-pop 0.22s var(--tc-ease) 1; }

.tc-sheen { position: relative; overflow: hidden; }
.tc-sheen::after {
  content: ""; position: absolute; inset: 0; pointer-events: none;
  background: var(--tc-grad-sheen);
  background-size: 220% 100%;
  background-position: -180% 0;
  opacity: 0;
  transition: opacity var(--tc-dur) var(--tc-ease);
}
.tc-sheen:hover::after {
  opacity: 1;
  animation: tc-sheen 0.7s var(--tc-ease) 1;
}

.tc-toast-in { animation: tc-toast 0.24s var(--tc-ease) both; }
.tc-fadein   { animation: tc-fadein 0.28s var(--tc-ease) both; }

.tc-elev-1 { box-shadow: var(--tc-elev-1); }
.tc-elev-2 { box-shadow: var(--tc-elev-2); }
.tc-elev-3 { box-shadow: var(--tc-elev-3); }

.tc-grad      { background-image: var(--tc-grad-panel); }
.tc-grad-card { background-image: var(--tc-grad-card); }

.tc-glass {
  background: var(--tc-glass);
  border: 1px solid var(--tc-glass-brd);
  box-shadow: var(--tc-elev-2);
}

.tc-glow-up   { box-shadow: var(--tc-glow-up); }
.tc-glow-down { box-shadow: var(--tc-glow-down); }
.tc-glow-btc  { box-shadow: var(--tc-glow-btc); }
.tc-glow-prob { box-shadow: var(--tc-glow-prob); }

.tc-tglow-up   { text-shadow: var(--tc-tglow-up); }
.tc-tglow-down { text-shadow: var(--tc-tglow-down); }
.tc-tglow-btc  { text-shadow: var(--tc-tglow-btc); }

.tc-gradient-border {
  position: relative;
  border: 1.5px solid transparent;
  background:
    linear-gradient(var(--tc-card), var(--tc-card)) padding-box,
    linear-gradient(120deg, #22d47b, #f7931a, #f7931a, #22d47b) border-box;
  background-size: 100% 100%, 100% 100%;
}
html[data-theme="light"] .tc-gradient-border {
  background:
    linear-gradient(var(--tc-card), var(--tc-card)) padding-box,
    linear-gradient(120deg, #0f9d58, #c2620e, #c2620e, #0f9d58) border-box;
  background-size: 100% 100%, 300% 100%;
}

.tc-live-glow { animation: tc-pulse-glow 2.4s ease-in-out infinite; }
.tc-tick      { animation: tc-tick 0.32s ease-out 1; }

.tc-cd-warn  { display: inline-block; animation: tc-cd-breathe 1.6s ease-in-out infinite; }
.tc-cd-crit  { display: inline-block; animation: tc-cd-beat 1s var(--tc-ease) infinite; will-change: transform; }
.tc-cd-colon { transition: opacity 0.18s ease; }
.tc-urgent-on number-flow { animation: tc-urgent 1s ease-in-out infinite; }

.tc-field {
  transition:
    border-color var(--tc-dur) var(--tc-ease),
    box-shadow var(--tc-dur) var(--tc-ease),
    background-color var(--tc-dur) var(--tc-ease);
}
.tc-field:focus-within {
  border-color: var(--tc-border-hi);
  box-shadow: inset 0 0 0 1px var(--tc-white-25), var(--tc-elev-1);
  background-color: var(--tc-hover);
}
.tc-field input::placeholder { color: var(--tc-dim); opacity: 1; }
.tc-field input { caret-color: var(--tc-text); }
.tc-field input:focus,
.tc-field input:focus-visible {
  box-shadow: none !important;
  outline: none !important;
  border-radius: 0;
}

.tc-reveal-nav { animation: tc-reveal-down 0.34s var(--tc-ease) both; }
.tc-reveal-1   { animation: tc-reveal-up   0.34s var(--tc-ease) 0.05s both; }
.tc-reveal-2   { animation: tc-reveal-up   0.34s var(--tc-ease) 0.12s both; }
.tc-reveal-3   { animation: tc-reveal-up   0.34s var(--tc-ease) 0.19s both; }

html.tc-theming, html.tc-theming *, html.tc-theming *::before, html.tc-theming *::after {
  transition:
    background-color 0.28s var(--tc-ease),
    color 0.28s var(--tc-ease),
    border-color 0.28s var(--tc-ease),
    box-shadow 0.28s var(--tc-ease) !important;
}

canvas {
  will-change: contents;
  transform: translateZ(0);
}
number-flow,
[data-number-flow-root] {
  will-change: transform;
  transform: translateZ(0);
  backface-visibility: hidden;
  font-variant-numeric: tabular-nums;
}
.market-card-anim {
  will-change: transform, opacity;
  transform: translateZ(0);
}

/* ── Spotlight system ────────────────────────────────────────── */
[data-spot] {
  transition:
    filter 0.26s var(--tc-ease),
    box-shadow 0.26s var(--tc-ease),
    outline-color 0.26s var(--tc-ease);
  outline: 1.5px solid transparent;
  outline-offset: 2px;
}
html[data-spotlight] [data-spot] {
  filter: brightness(0.38) saturate(0.6);
}
html[data-theme="light"][data-spotlight] [data-spot] {
  filter: brightness(0.84) saturate(0.5);
}
html[data-spotlight~="wallet"]   [data-spot~="wallet"],
html[data-spotlight~="markets"]  [data-spot~="markets"],
html[data-spotlight~="carousel"] [data-spot~="carousel"],
html[data-spotlight~="chart"]    [data-spot~="chart"],
html[data-spotlight~="trading"]  [data-spot~="trading"],
html[data-spotlight~="social"]   [data-spot~="social"],
html[data-spotlight~="log"]      [data-spot~="log"],
html[data-spotlight~="brand"]    [data-spot~="brand"] {
  filter: none !important;
  outline-color: var(--tc-spot-ring);
  box-shadow: var(--tc-spot-glow), var(--tc-elev-2);
  z-index: 5;
}

/* ── Boot screen ─────────────────────────────────────────────── */
#tc-boot-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 24px;
  background: var(--tc-bg);
  transition: opacity 0.6s var(--tc-ease);
}
#tc-boot-overlay.tc-boot-done {
  opacity: 0;
  pointer-events: none;
}
.tc-boot-brand {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 20px;
}
/* Polymarket mark above the wordmark */
.tc-boot-logo-wrap {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}
.tc-boot-poly {
  overflow: visible;
  transform-origin: 50% 50%;
  filter: drop-shadow(0 0 16px rgba(255,255,255,0.45));
}
.tc-boot-poly path {
  fill: var(--tc-text-strong);
}
/* shard layer — anchored at the logo centre so pieces fan out from a point */
.tc-boot-shards {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
  pointer-events: none;
}
.tc-boot-shard {
  position: absolute;
  left: 0;
  top: 0;
  width: 12px;
  height: 12px;
  margin: -6px 0 0 -6px;
  background: var(--tc-text-strong);
  /* angular fragment, not a dot */
  clip-path: polygon(50% 0%, 100% 75%, 18% 100%);
  box-shadow: 0 0 8px rgba(255,255,255,0.5);
  will-change: transform, opacity;
}
.tc-boot-word {
  position: relative;
  font-family: 'Inter Polymarket', Inter, system-ui, sans-serif;
  font-weight: 800;
  font-size: 1.6rem;
  letter-spacing: -0.02em;
  color: var(--tc-text-strong);
  white-space: nowrap;
}
/* each letter is its own transform context (bounce wave + explosion burst) */
.tc-boot-char {
  display: inline-block;
  will-change: transform, opacity;
}
/* particle burst layer — anchored at the wordmark centre, zero-size so the
   children fan out from a single point */
.tc-boot-particles {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 0;
  height: 0;
  pointer-events: none;
}
.tc-boot-particle {
  position: absolute;
  left: 0;
  top: 0;
  width: 6px;
  height: 6px;
  margin: -3px 0 0 -3px;
  border-radius: 50%;
  background: var(--tc-text-strong);
  box-shadow: 0 0 8px var(--tc-text-strong);
  will-change: transform, opacity;
}

/* ── Dead state overlay ──────────────────────────────────────── */
#tc-app-root {
  transition: filter 0.9s var(--tc-ease);
}
/* Boot blur — the app sits out of focus under the curtain and snaps sharp as
   the overlay explodes (the unblur transition runs together with the burst). */
#tc-app-root.tc-boot-blur {
  filter: blur(22px);
}
html[data-conn="dead"] #tc-app-root {
  pointer-events: none;
  filter: saturate(0.25) brightness(0.55);
}

/* ── Left dock (reorderable / resizable panels) ──────────────── */
.tc-dock-panel {
  border-radius: var(--tc-r-card, 10px);
  transition: box-shadow 0.18s var(--tc-ease);
}
.tc-dock-dragging {
  box-shadow: 0 14px 38px rgba(0,0,0,0.55), 0 0 0 1px var(--tc-border-hi);
  opacity: 0.97;
  cursor: grabbing;
}
/* invisible-until-hover resize handle straddling the gap below a panel */
.tc-dock-splitter {
  position: absolute;
  left: 0; right: 0; bottom: -8px;
  height: 14px;
  cursor: ns-resize;
  z-index: 12;
}
.tc-dock-splitter::after {
  content: '';
  position: absolute;
  left: 14%; right: 14%; top: 50%;
  height: 3px; transform: translateY(-50%);
  border-radius: 3px;
  background: var(--tc-text-strong);
  opacity: 0;
  transition: opacity 0.16s var(--tc-ease);
}
.tc-dock-splitter:hover::after { opacity: 0.55; }
/* insertion indicator while reordering */
.tc-dock-drop {
  flex-shrink: 0;
  height: 3px;
  border-radius: 3px;
  background: var(--tc-up, #22c55e);
  box-shadow: var(--tc-glow-up);
  animation: tc-fadein 0.12s var(--tc-ease) both;
}
.tc-dock-reset {
  align-self: flex-end;
  flex-shrink: 0;
  margin-top: -2px;
  padding: 2px 8px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.58rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--tc-dim3);
  background: transparent;
  border: 1px solid var(--tc-border);
  border-radius: 6px;
  cursor: pointer;
  opacity: 0.5;
  transition: opacity 0.16s var(--tc-ease), color 0.16s var(--tc-ease);
}
.tc-dock-reset:hover { opacity: 1; color: var(--tc-text); }

/* ── Top-bar scoreboard: icon chips with clever hover-reveal ─────
   Rest: icon + value. Hover the cluster → every chip collapses to its icon to
   free space; the chip actually hovered expands to show its label + a plain
   explanation. Sibling-aware, all via flex + width transitions (no JS layout). */
.tc-chip {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 7px;
  border-radius: 8px;
  white-space: nowrap;
  flex-shrink: 0;
  transition: background-color 0.18s var(--tc-ease);
}
.tc-chip-val {
  overflow: hidden;
  max-width: 90px;
  opacity: 1;
  transition: max-width 0.28s var(--tc-ease), opacity 0.2s var(--tc-ease), margin 0.28s var(--tc-ease);
}
/* Explanation — expands INLINE (like the left controls), pushing the
   neighbours over to make room rather than overlaying them. */
.tc-chip-det {
  overflow: hidden;
  display: inline-flex;
  align-items: baseline;
  gap: 5px;
  max-width: 0;
  margin-left: 0;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.72rem;
  font-weight: 600;
  color: var(--tc-text-2);
  letter-spacing: 0.01em;
  line-height: 1.5;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transition: max-width 0.3s var(--tc-ease), opacity 0.2s var(--tc-ease), margin 0.3s var(--tc-ease);
}
.tc-chip-det b {
  font-weight: 800;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  font-size: 0.66rem;
  color: var(--tc-text-strong);
}
/* The active chip keeps its value + pops its explanation to the side. The other
   stats stay put — no collapsing the rest of the row on hover. */
.tc-scoreboard .tc-chip.is-active {
  background: var(--tc-hover);
}
.tc-chip.is-active .tc-chip-det {
  max-width: 320px;
  margin-left: 7px;
  opacity: 1;
}

/* ── Back-to-live button ─────────────────────────────────────── */
.tc-back-live {
  transition: border-color 0.18s var(--tc-ease), box-shadow 0.18s var(--tc-ease), background-color 0.18s var(--tc-ease);
}
.tc-back-live:hover {
  border-color: #34d399 !important;
  box-shadow: 0 0 0 1px rgba(34,197,94,0.45), 0 8px 26px rgba(34,197,94,0.30);
}
.tc-bl-arrow { transition: transform 0.2s var(--tc-ease); }
.tc-back-live:hover .tc-bl-arrow { transform: translateX(3px); }

/* ── Drag-reorder drop marker ────────────────────────────────── */
.tc-drag-mark {
  flex-shrink: 0;
  align-self: center;
  width: 3px;
  height: 26px;
  margin: 0 -1px;
  border-radius: 3px;
  background: var(--tc-up, #22c55e);
  box-shadow: var(--tc-glow-up);
  animation: tc-fadein 0.1s var(--tc-ease) both;
}

/* The Polymarket mark svg is filled white; invert it to dark in light mode. */
html[data-theme="light"] .tc-poly-logo { filter: invert(1); }

/* ── Liquid-glass surface ────────────────────────────────────── */
.tc-glass {
  background: var(--tc-glass-bg);
  backdrop-filter: var(--tc-glass-blur);
  -webkit-backdrop-filter: var(--tc-glass-blur);
  border: 1px solid var(--tc-glass-brd);
}

/* ── Connection-lost banner ──────────────────────────────────── */
.tc-conn-banner {
  position: fixed;
  top: 0; left: 0; right: 0;
  z-index: 10000;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 8px 16px;
  background: rgba(239,68,68,0.12);
  border-bottom: 1px solid rgba(239,68,68,0.45);
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--tc-red, #ef4444);
  letter-spacing: 0.03em;
  animation: tc-fadein 0.2s var(--tc-ease) both;
}

/* ── Feed degraded banner ────────────────────────────────────── */
.tc-feed-banner {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  flex-shrink: 0;
  padding: 5px 12px;
  background: rgba(245,158,11,0.10);
  border: 1px solid rgba(245,158,11,0.45);
  border-radius: 8px;
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.7rem;
  font-weight: 700;
  color: var(--tc-gold, #f59e0b);
  letter-spacing: 0.03em;
}

/* ── Reduced motion ──────────────────────────────────────────── */
@media (prefers-reduced-motion: reduce) {
  .tc-gradient-border, .tc-live-glow, .tc-skel,
  .tc-sheen:hover::after,
  .tc-tick, .tc-toast-in, .tc-cd-warn, .tc-cd-crit,
  .tc-reveal-nav, .tc-reveal-1, .tc-reveal-2, .tc-reveal-3,
  .tc-boot-spinner,
  .tc-urgent-on number-flow {
    animation: none !important;
  }
  /* no boot blur under reduced motion — keep the app sharp */
  #tc-app-root.tc-boot-blur { filter: none; }
}

/* ── Nav stats strip — responsive breakpoints ───────────────── */
.tc-stats-strip { display: none !important; }
@media (min-width: 768px) {
  .tc-stats-strip { display: flex !important; }
  .tc-stat-core  { display: flex !important; }
  .tc-stat-wl    { display: none; }
  .tc-stat-extra { display: none; }
}
@media (min-width: 992px)  { .tc-stat-wl    { display: flex !important; } }
@media (min-width: 1280px) { .tc-stat-extra { display: flex !important; } }

/* ── Mobile layout ───────────────────────────────────────────── */
.tc-mobile-bottom { display: none; }
@media (max-width: 767px) {
  .tc-left-col,
  .tc-right-col { display: none !important; }
  .tc-mobile-bottom {
    display: flex !important;
    flex-direction: column;
    flex-shrink: 0;
    max-height: 60vh;
    overflow-y: auto;
    border-top: 1px solid var(--tc-border);
    width: 100%;
    background: var(--tc-bg);
  }
}

html[data-power="low"] .tc-gradient-border,
html[data-power="low"] .tc-live-glow,
html[data-power="low"] .tc-sheen::after {
  animation: none !important;
}

/* ── Carousel slots scrollbar hide ──────────────────────────── */
.tc-carousel-slots::-webkit-scrollbar { display: none; }

/* ── Nav tooltip ─────────────────────────────────────────────── */
.tc-nav-tooltip-wrap {
  position: relative;
  display: inline-flex;
}
.tc-nav-tooltip {
  position: absolute;
  /* nav is at the top of the screen — show below the button, not above (off-screen) */
  top: calc(100% + 6px);
  left: 50%;
  transform: translateX(-50%);
  background: var(--tc-panel);
  border: 1px solid var(--tc-border);
  color: var(--tc-text);
  border-radius: 6px;
  padding: 3px 8px;
  font-size: 11px;
  white-space: nowrap;
  pointer-events: none;
  opacity: 0;
  transition: opacity 120ms;
  z-index: 9999;
}
.tc-nav-tooltip-wrap:hover .tc-nav-tooltip { opacity: 1; }

/* ── Mobile market sidebar scroll ───────────────────────────── */
@media (max-width: 768px) {
  :root { --tc-card-min-w: 180px; }
  .tc-left-col [data-spot='markets'] {
    overflow-x: auto;
    overflow-y: hidden;
  }
  .tc-left-col [data-spot='markets'] > * {
    flex-direction: row !important;
    flex-wrap: nowrap;
  }
}

/* ── Connection-lost modal overlay ──────────────────────────── */
#tc-conn-lost {
  position: fixed;
  inset: 0;
  z-index: 10500;
  display: none;
  pointer-events: none;
  align-items: center;
  justify-content: center;
}
html[data-conn='dead'] #tc-conn-lost { display: flex; }
.tc-conn-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 11px;
  background: var(--tc-card);
  border: 1px solid var(--tc-border-hi);
  border-radius: 14px;
  padding: 26px 40px;
  animation: tc-toast 0.3s var(--tc-ease) both;
}
.tc-conn-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: rgb(208,216,230);
  animation: tc-conn-pulse 1.3s ease-in-out infinite;
}
.tc-conn-head {
  color: rgb(208,216,230);
  font-weight: 800;
  letter-spacing: 0.16em;
  font-size: 0.72rem;
  font-family: var(--tc-font-mono, monospace);
}
.tc-conn-sub { color: var(--tc-dim3); font-size: 0.65rem; }

/* ── TradingBar mobile bottom-sheet ─────────────────────────── */
.tc-trading-bar {
  max-height: 80vh;
  border-radius: 16px 16px 0 0;
  border-top: 1px solid var(--tc-border);
  box-shadow: none;
}
@media (min-width: 1024px) {
  .tc-trading-bar {
    max-height: 100%;
    border-radius: 0;
    border-top: none;
    box-shadow: var(--tc-elev-2);
  }
}
`

export function injectTheme(): void {
  // Reuse the existing tag if present and refresh its content, so theme edits
  // (e.g. hot-reload) actually apply instead of leaving stale CSS in place.
  const existing = document.getElementById('tc-theme') as HTMLStyleElement | null
  if (existing) {
    if (existing.textContent !== CSS) existing.textContent = CSS
    return
  }
  const el = document.createElement('style')
  el.id = 'tc-theme'
  el.textContent = CSS
  document.head.insertBefore(el, document.head.firstChild)
}
