import React, { useEffect, useRef, useState } from 'react'
import { animate, scrambleText } from 'animejs'
import { useStore } from '../store.js'
import type { Toast, ToastLevel } from '../store.js'
import { C, Z, FONT, SP, FS, FW } from '../constants/index.js'

// ── Per-level styling ─────────────────────────────────────────────────────────
// Hollow-frame aesthetic to match the rest of the UI: translucent surface,
// colored border + colored text + a colored glyph. Green=log, orange=warn,
// red=error.

const LEVEL: Record<ToastLevel, { color: string; border: string; bg: string; glow: string; glyph: string }> = {
  log: {
    color: C.GREEN,
    border: C.GREEN_BORDER,
    bg: C.GREEN_BG,
    glow: 'rgba(34,212,123,0.28)',
    glyph: '✓',
  },
  warn: {
    color: C.GOLD,
    border: C.GOLD_BORDER,
    bg: C.GOLD_BG,
    glow: 'rgba(245,158,11,0.28)',
    glyph: '!',
  },
  error: {
    color: C.RED,
    border: C.RED_BORDER,
    bg: C.RED_BG,
    glow: 'rgba(239,68,68,0.30)',
    glyph: '✕',
  },
}

// Errors linger longest, warnings a bit, logs shortest.
const TTL: Record<ToastLevel, number> = { log: 3500, warn: 5000, error: 6500 }

// ── Single toast bubble ─────────────────────────────────────────────────────

// Springy ease for the enter (slight overshoot), gentle ease for the exit.
const EASE_IN = 'cubic-bezier(0.16, 1.1, 0.3, 1)'
const EASE_OUT = 'cubic-bezier(0.4, 0, 0.85, 0.4)'
const ENTER_MS = 320
const EXIT_MS = 240

function ToastItem({ toast }: { toast: Toast }) {
  const dismiss = useStore((s) => s._dismissToast)
  // 'in' = freshly mounted (offscreen-low), 'shown' = settled, 'out' = leaving (drop down)
  const [phase, setPhase] = useState<'in' | 'shown' | 'out'>('in')
  const L = LEVEL[toast.level] ?? LEVEL.log

  // Float up on mount: flip from the offset start to the settled position on the
  // next frame so the transition actually animates.
  useEffect(() => {
    const raf = requestAnimationFrame(() => setPhase('shown'))
    return () => cancelAnimationFrame(raf)
  }, [])

  const leave = () => setPhase('out')

  // Auto-dismiss after the level's TTL.
  useEffect(() => {
    const ttl = TTL[toast.level] ?? TTL.log
    const out = setTimeout(leave, ttl)
    return () => clearTimeout(out)
  }, [toast.id, toast.level])

  // Once leaving, drop down + fade, then remove from the store.
  useEffect(() => {
    if (phase !== 'out') return
    const done = setTimeout(() => dismiss(toast.id), EXIT_MS)
    return () => clearTimeout(done)
  }, [phase, toast.id, dismiss])

  const entering = phase === 'in'
  const leaving = phase === 'out'

  // Decode the text in on mount (anime.js scrambleText).
  const textRef = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    const el = textRef.current
    if (!el) return
    const anim = animate(el, {
      innerHTML: scrambleText({ chars: 'uppercase', from: 'left' }),
      duration: 900,
      ease: 'linear',
    })
    return () => { try { anim.revert() } catch { /* ignore */ } }
  }, [])

  return (
    <div
      onClick={leave}
      style={{
        pointerEvents: 'auto',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: SP.LG,
        minWidth: 220,
        maxWidth: 420,
        padding: `${SP.LG} ${SP.XXL}`,
        borderRadius: 12,
        border: `1px solid ${L.border}`,
        background: `color-mix(in srgb, var(--tc-panel) 82%, transparent)`,
        backdropFilter: 'blur(8px)',
        WebkitBackdropFilter: 'blur(8px)',
        boxShadow: `0 6px 22px var(--tc-scrim), 0 0 0 1px ${L.bg}, 0 0 18px ${L.glow}`,
        color: L.color,
        fontFamily: FONT.SANS,
        fontSize: 13.5,
        fontWeight: FW.SEMI,
        lineHeight: 1.35,
        letterSpacing: '0.01em',
        // Enter: rise up from +18px (slightly squashed). Exit: drop down to +18px.
        opacity: entering || leaving ? 0 : 1,
        transform: entering
          ? 'translateY(18px) scale(0.94)'
          : leaving
            ? 'translateY(18px) scale(0.97)'
            : 'translateY(0) scale(1)',
        transition: leaving
          ? `opacity ${EXIT_MS}ms ${EASE_OUT}, transform ${EXIT_MS}ms ${EASE_OUT}`
          : `opacity ${ENTER_MS}ms ${EASE_IN}, transform ${ENTER_MS}ms ${EASE_IN}`,
      }}
    >
      {/* glyph badge — hollow ring in the level color */}
      <span
        aria-hidden
        style={{
          flex: '0 0 auto',
          width: SP.XXL,
          height: SP.XXL,
          borderRadius: '50%',
          border: `1.5px solid ${L.color}`,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: FS.XS,
          fontWeight: FW.XBOLD,
          lineHeight: 1,
        }}
      >
        {L.glyph}
      </span>
      <span ref={textRef} style={{ flex: 1, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{toast.text}</span>
    </div>
  )
}

// ── Toast stack (bottom-center, newest floats up from the bottom) ────────────

export function Toasts() {
  const toasts = useStore((s) => s._toasts)
  if (!toasts.length) return null
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 22,
        left: '50%',
        transform: 'translateX(-50%)',
        zIndex: Z.TOAST,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: SP.MD,
        pointerEvents: 'none',
        maxWidth: 'calc(100vw - 24px)',
      }}
    >
      {toasts.map((t) => (
        <ToastItem key={t.id} toast={t} />
      ))}
    </div>
  )
}
