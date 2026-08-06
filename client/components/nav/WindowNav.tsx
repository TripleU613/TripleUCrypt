import { useState, useEffect, useRef } from 'react'
import { animate } from 'animejs'
import useEmblaCarousel from 'embla-carousel-react'
import { playFx } from '../../lib/fx.js'
import { useStore } from '../../store.js'
import { call } from '../../api.js'
import { computeTimeSlots, type TimeSlot } from '../../lib/compute.js'
import { C, FONT, D, MS, STR, SP, SZ, FS, FW } from '../../constants/index.js'


function OutcomeCircle({ slot }: { slot: TimeSlot }) {
  if (slot.is_current) {
    return (
      <span
        style={{
          width: SP.SM, height: SP.SM, borderRadius: '50%',
          background: C.RED,
          boxShadow: `0 0 6px ${C.RED}`,
          flexShrink: 0,
          display: 'inline-block',
          animation: 'tcpulse 2.4s ease-in-out infinite',
        }}
      />
    )
  }
  if (slot.result === 'UP' || slot.result === 'DOWN') {
    const color = slot.result === 'UP' ? C.GREEN : C.RED
    const glow = slot.result === 'UP'
      ? 'var(--tc-glow-up)'
      : '0 0 0 1px rgba(239,68,68,0.45), 0 0 18px rgba(239,68,68,0.26)'
    return (
      <span
        style={{
          width: SP.MD, height: SP.MD, borderRadius: '50%',
          background: color, boxShadow: glow,
          flexShrink: 0, display: 'inline-block',
        }}
      />
    )
  }
  return <span style={{ width: SP.SM, height: SP.SM, flexShrink: 0, display: 'inline-block' }} />
}

function Slot({ slot, compact = false }: { slot: TimeSlot; compact?: boolean }) {
  const viewing = slot.is_viewing
  const [hovered, setHovered] = useState(false)

  // nav_002: white on hover for inactive slots; nav_004: data-spot-for attribute
  const color = viewing ? C.WHITE : hovered ? C.WHITE : C.DIM3

  return (
    <div
      onClick={() => call('set_viewing_slot', slot.ts)}
      onMouseEnter={(e) => { setHovered(true); playFx(e.currentTarget, 'pulse') }}
      onMouseLeave={() => setHovered(false)}
      data-slot-ts={slot.ts}
      data-spot-for="carousel chart trading"
      style={{
        position: 'relative', zIndex: 1,
        cursor: 'pointer',
        padding: compact ? `${SP.MD} ${SP.XXS}` : `${SP.XS} ${SP.SM}`,
        borderRadius: D.R_SM,
        minWidth: compact ? 0 : '56px',
        width: compact ? '100%' : undefined,
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        color,
        background: compact && viewing ? 'var(--tc-active)' : 'transparent',
        border: compact ? `1px solid ${viewing ? 'var(--tc-border-hi)' : 'transparent'}` : undefined,
        userSelect: 'none',
        flexShrink: 0,
        transition: 'color 0.16s cubic-bezier(.4,0,.2,1), background 0.16s',
      }}
    >
      <span style={{ display: 'flex', alignItems: 'center', gap: compact ? SP.XS : SP.XS, minWidth: 0 }}>
        <OutcomeCircle slot={slot} />
        <span style={{
          fontSize: compact ? FS.XS : FS.SM, fontWeight: FW.BOLD, fontFamily: FONT.MONO, lineHeight: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0,
        }}>
          {slot.label}
        </span>
      </span>
    </div>
  )
}

function SkeletonSlot() {
  return (
    <div style={{
      padding: `${SP.XS} ${SP.MD}`, minWidth: '62px', display: 'flex',
      justifyContent: 'center', alignItems: 'center', flexShrink: 0,
    }}>
      <div className="tc-skel" style={{
        width: SZ.S44, height: SP.XL, borderRadius: D.R_XS,
      }} />
    </div>
  )
}

function Arrow({ dir, onClick }: { dir: 'left' | 'right'; onClick: () => void }) {
  // nav_001: white color + white-07 bg + elev-1 shadow on hover, 120ms transition
  const [hovered, setHovered] = useState(false)

  return (
    <div
      onClick={onClick}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="tc-hoverlift"
      style={{
        cursor: 'pointer', width: SZ.S24, height: SZ.S24,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRadius: D.R_SM,
        color: hovered ? C.WHITE : C.DIM3,
        background: hovered ? 'var(--tc-white-07)' : 'transparent',
        boxShadow: hovered ? 'var(--tc-elev-1)' : 'none',
        flexShrink: 0,
        transition: 'all 120ms',
        userSelect: 'none',
      }}
      title={dir === 'left' ? STR.WIN_EARLIER : STR.WIN_LATER}
    >
      {dir === 'left' ? '‹' : '›'}
    </div>
  )
}

// Grip dots — a draggable affordance (reorder handle) that Embla never sees.
function GripIcon({ color }: { color: string }) {
  return (
    <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" style={{ display: 'block', color }} aria-hidden="true">
      <circle cx="2.5" cy="3" r="1.3" /><circle cx="7.5" cy="3" r="1.3" />
      <circle cx="2.5" cy="8" r="1.3" /><circle cx="7.5" cy="8" r="1.3" />
      <circle cx="2.5" cy="13" r="1.3" /><circle cx="7.5" cy="13" r="1.3" />
    </svg>
  )
}

export function WindowNav({ onGripPointerDown, dragging = false, fluid = false }: {
  onGripPointerDown?: (e: React.PointerEvent) => void
  dragging?: boolean
  // fluid = mobile: always expanded, fills the full width (no hover, no cap).
  fluid?: boolean
} = {}) {
  const allWindows = useStore(s => s.windows)
  const activeIdx = useStore(s => s.active_window)
  // The slot strip walks the SELECTED window's boundaries — its interval is the
  // step size, so feeding computeTimeSlots the whole array (whose [0] is always
  // BTC 5m) would step a 1h/1d strip in five-minute slots.
  const windows = allWindows[activeIdx] ? [allWindows[activeIdx]] : allWindows
  const slotOffset = useStore(s => s.slot_offset)
  const viewingSlot = useStore(s => s.viewing_slot)
  const slotResults = useStore(s => s.slot_results)
  const marketsReady = windows.length > 0

  const [liveHovered, setLiveHovered] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const isOpen = fluid || expanded
  // Collapse the moment a reorder drag lifts this module.
  useEffect(() => { if (dragging) setExpanded(false) }, [dragging])

  const nowTs = Math.floor(Date.now() / 1000)

  // collapsedW tracks the footprint width (synced by the ResizeObserver below).
  const [collapsedW, setCollapsedW] = useState(0)
  // Mobile (fluid): pick an odd slot count that fills the width — current stays
  // centred. Caps at 11 so even a wide phone/tablet shows a sensible row.
  const fluidSpan = (() => {
    const w = collapsedW || 360
    let n = Math.floor((w - 56) / 60)      // ~60px/slot so HH:MM labels never clip
    n = Math.max(5, Math.min(9, n))
    if (n % 2 === 0) n -= 1
    return (n - 1) / 2
  })()
  const slots = computeTimeSlots(windows, slotOffset, viewingSlot, slotResults, nowTs, fluid ? fluidSpan : 2)

  // Embla: smooth, momentum (dragFree) carousel, centred snapping.
  const [emblaRef, embla] = useEmblaCarousel({
    align: 'center', dragFree: true, containScroll: 'trimSnaps', skipSnaps: false,
  })

  const indRef = useRef<HTMLDivElement>(null)
  const footRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef(true)
  const viewingIdx = slots.findIndex(s => s.is_viewing)
  const viewingTs = slots.find(s => s.is_viewing)?.ts
  const currentIdx = (() => {
    if (viewingIdx >= 0) return viewingIdx
    const i = slots.findIndex(s => s.is_current)
    return i >= 0 ? i : Math.floor(slots.length / 2)
  })()

  // Position the sliding green frame over the selected slide. Tracks the slide
  // live as Embla scrolls (instant), and slides to it on selection (animated).
  const placeIndicator = (animated: boolean) => {
    const ind = indRef.current
    if (!ind || !embla) return
    const vp = embla.rootNode()
    const slide = viewingIdx >= 0 ? embla.slideNodes()[viewingIdx] : null
    if (!vp || !slide) { ind.style.opacity = '0'; return }
    const vr = vp.getBoundingClientRect(), sr = slide.getBoundingClientRect()
    const left = sr.left - vr.left, width = sr.width
    if (animated && !firstRef.current) {
      animate(ind, { left: `${left}px`, width: `${width}px`, opacity: 1, duration: 340, ease: 'out(3)' })
    } else {
      ind.style.left = `${left}px`; ind.style.width = `${width}px`; ind.style.opacity = '1'
    }
  }

  // Track the frame on every Embla movement (drag/momentum/resize).
  useEffect(() => {
    if (!embla) return
    const track = () => placeIndicator(false)
    embla.on('scroll', track).on('reInit', track)
    return () => { embla.off('scroll', track).off('reInit', track) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embla, viewingIdx])

  // Slide the frame to the newly selected slot.
  useEffect(() => {
    placeIndicator(true)
    firstRef.current = false
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewingTs, slots.length])

  // Width is px-only on BOTH ends so a CSS transition animates smoothly (a
  // %→px transition snaps; and letting anime set width while React re-renders
  // it back to 100% made it jitter). collapsedW tracks the footprint; expandedW
  // hugs the slot content (capped); dir decides which way it grows so it never
  // expands into a wall.
  const [expandedW, setExpandedW] = useState(0)
  const [dir, setDir] = useState<'l' | 'r'>('r')

  // Keep collapsedW synced to the footprint.
  useEffect(() => {
    const foot = footRef.current
    if (!foot) return
    const sync = () => setCollapsedW(foot.clientWidth)
    sync()
    const ro = new ResizeObserver(sync)
    ro.observe(foot)
    return () => ro.disconnect()
  }, [])

  const openExpand = () => {
    if (dragging) return
    const foot = footRef.current
    if (foot) {
      const r = foot.getBoundingClientRect()
      setDir(r.left + r.width / 2 < window.innerWidth / 2 ? 'r' : 'l')  // grow toward centre
    }
    const content = embla?.containerNode()?.scrollWidth ?? 320
    setExpandedW(Math.min(440, content + 70))   // arrows + grip + padding, capped
    setExpanded(true)
  }

  // Re-centre the current/live slot when the slot set changes.
  useEffect(() => {
    if (!embla) return
    const recentre = () => { embla.reInit(); embla.scrollTo(currentIdx, true); placeIndicator(false) }
    recentre()
    const t = setTimeout(recentre, 460)
    return () => clearTimeout(t)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [embla, expanded, slotOffset, slots.length])

  // Mobile (fluid): a static full-width row — the current window stays centred
  // (it's the middle of an odd slot set) and the extra windows fill the width.
  if (fluid) {
    return (
      <div ref={footRef} style={{ position: 'relative', width: '100%', minWidth: 0 }}>
        <div className="tc-glass" style={{
          display: 'flex', alignItems: 'center', gap: SP.XXS, width: '100%',
          padding: `${SP.XXS} ${SP.XS}`, borderRadius: '7px', boxShadow: 'var(--tc-elev-1)', boxSizing: 'border-box',
        }}>
          <Arrow dir="left" onClick={() => call('slots_back')} />
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' }}>
            {marketsReady
              ? slots.map(slot => (
                  <div key={slot.ts} style={{ flex: '1 1 0', minWidth: 0, display: 'flex', justifyContent: 'center' }}>
                    <Slot slot={slot} compact />
                  </div>
                ))
              : Array.from({ length: 7 }, (_, i) => (
                  <div key={i} style={{ flex: '1 1 0', minWidth: 0, display: 'flex', justifyContent: 'center' }}>
                    <div className="tc-skel" style={{ width: SZ.S34, height: SP.XL, borderRadius: D.R_XS }} />
                  </div>
                ))}
          </div>
          <Arrow dir="right" onClick={() => call('slots_forward')} />
          {slotOffset !== 0 && (
            <div
              onClick={() => call('slots_live')}
              className="tc-hoverlift"
              title={STR.WIN_BACK_LIVE}
              style={{
                cursor: 'pointer', width: SZ.S24, height: SZ.S24, flexShrink: 0,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: D.R_SM, color: C.RED,
              }}
            >●</div>
          )}
        </div>
      </div>
    )
  }

  return (
    // Footprint fills the rest of the controls group → its right edge is flush
    // with the left sidebar. Collapsed, the glass card fills the footprint;
    // on hover it overlays to the right.
    <div ref={footRef} style={{ position: 'relative', alignSelf: 'stretch', width: '100%', minWidth: 0, flex: 1 }}>
      <div
        ref={cardRef}
        className="tc-glass"
        onMouseEnter={fluid ? undefined : openExpand}
        onMouseLeave={fluid ? undefined : () => setExpanded(false)}
        style={{
          position: 'absolute', top: '50%', transform: 'translateY(-50%)',
          // anchor on the side toward the bar centre so it grows inward
          left: fluid ? 0 : dir === 'r' ? 0 : 'auto',
          right: fluid ? 0 : dir === 'l' ? 0 : 'auto',
          display: 'flex', alignItems: 'center', gap: SP.XS,
          padding: `${SP.XXS} ${SP.XXS}`, borderRadius: '5px',
          boxShadow: expanded ? '0 10px 32px rgba(0,0,0,0.45)' : 'var(--tc-elev-1)',
          // fluid → fill the row full-width; otherwise px both ends → smooth anim
          width: fluid ? '100%' : `${expanded ? expandedW : collapsedW}px`,
          overflow: 'hidden',
          transition: fluid ? 'box-shadow 0.3s var(--tc-ease)' : 'width 0.4s cubic-bezier(.22,1,.36,1), box-shadow 0.3s var(--tc-ease)',
          zIndex: expanded ? 50 : 2,
        }}
      >
        {/* Reorder grip — owns the press-hold so the carousel module is
            draggable while Embla still scrolls the slots. touchAction:none lets
            a touch hold-drag start a reorder instead of scrolling the page. */}
        {onGripPointerDown && (
          <div
            onPointerDown={onGripPointerDown}
            title={STR.WIN_DRAG}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              alignSelf: 'stretch', padding: `${SP.NONE} ${SP.XXS}`, cursor: 'grab',
              color: C.DIM3, flexShrink: 0, touchAction: 'none', userSelect: 'none',
            }}
          >
            <GripIcon color="currentColor" />
          </div>
        )}

        {isOpen && <Arrow dir="left" onClick={() => call('slots_back')} />}

        {/* Embla viewport */}
        <div ref={emblaRef} style={{ position: 'relative', overflow: 'hidden', flex: 1, minWidth: 0 }}>
          {/* container (Embla uses the first child) */}
          <div style={{ position: 'relative', zIndex: 1, display: 'flex', alignItems: 'center', gap: SP.XS }}>
            {marketsReady
              ? slots.map(slot => (
                  <div key={slot.ts} style={{ flex: '0 0 auto', minWidth: 0 }}>
                    <Slot slot={slot} />
                  </div>
                ))
              : [0, 1, 2, 3, 4].map(i => (
                  <div key={i} style={{ flex: '0 0 auto' }}><SkeletonSlot /></div>
                ))
            }
          </div>
          {/* sliding green selection frame — sibling of the container so Embla
              never treats it as a slide; positioned in JS to track the slide */}
          <div ref={indRef} style={{
            position: 'absolute', top: 0, bottom: 0, left: 0, width: 0, opacity: 0,
            border: `1px solid ${C.GREEN}`, borderRadius: '5px',
            boxShadow: 'var(--tc-glow-up)', pointerEvents: 'none', boxSizing: 'border-box', zIndex: 0,
          }} />
        </div>

        {isOpen && <Arrow dir="right" onClick={() => call('slots_forward')} />}

        {/* Jump-to-live — only when scrolled away (and open) */}
        {isOpen && slotOffset !== 0 && (
          <div
            onClick={() => call('slots_live')}
            onMouseEnter={() => setLiveHovered(true)}
            onMouseLeave={() => setLiveHovered(false)}
            className="tc-hoverlift"
            title={STR.WIN_BACK_LIVE}
            style={{
              cursor: 'pointer', width: SZ.S24, height: SZ.S24,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              borderRadius: D.R_SM, color: C.RED,
              background: liveHovered ? C.RED + '22' : 'transparent',
              boxShadow: liveHovered ? 'var(--tc-glow-down)' : 'none',
              flexShrink: 0, marginLeft: SP.XXS,
              transition: 'all 120ms',
            }}
          >
            ●
          </div>
        )}
      </div>
    </div>
  )
}
