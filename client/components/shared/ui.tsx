/**
 * Shared UI primitives — the skeleton placeholder atom and the ghost
 * (outline) segmented-control style.
 */

import React from 'react'
import { C, D } from '../../constants/index.js'

// ── Skeleton primitives ────────────────────────────────────────────────────────

interface SkelBoxProps {
  w?: string | number
  h?: string | number
  radius?: string
  className?: string
  style?: React.CSSProperties
}

/** A single shimmering bar — the atom every other skeleton is built from. */
export function SkelBox({ w = '100%', h = '12px', radius = D.R_XS, className, style }: SkelBoxProps): JSX.Element {
  return (
    <div
      className={['tc-skel', className].filter(Boolean).join(' ')}
      style={{
        width: w,
        height: h,
        borderRadius: radius,
        background: 'var(--tc-hover)',
        flexShrink: 0,
        ...style,
      }}
    />
  )
}

// ── Ghost (outline) style helpers — the debloat / skeletonize look ─────────────
// Reuse these instead of hand-rolling outline styles per component:
//   active = hollow frame (transparent bg + accent border + accent text)

/** Style for a segmented-control option (active = accent frame, no fill). */
export function ghostSegStyle(active: boolean, accent: string = C.GREEN, hovered = false): React.CSSProperties {
  return {
    color: active ? accent : hovered ? C.WHITE : 'var(--tc-dim2)',
    background: active ? 'transparent' : hovered ? 'var(--tc-white-05)' : 'transparent',
    border: `1px solid ${active ? accent : 'transparent'}`,
    boxSizing: 'border-box',
    transition: 'all 0.16s cubic-bezier(.4,0,.2,1)',
  }
}
