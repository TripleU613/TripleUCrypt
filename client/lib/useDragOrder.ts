/**
 * useDragOrder — horizontal press-and-hold drag-to-reorder for a row of items,
 * persisted to localStorage and animated with FLIP.
 *
 * Items are identified by string ids. The hook owns the order; the caller maps
 * each id to its element and renders them in `order`. Reordering is drop-based:
 * the grabbed item follows the cursor, and on release the row commits the new
 * order and FLIP-animates everything into place.
 *
 * A quick tap/click (no hold, no move) passes straight through to the item, so
 * buttons keep working. `dragging` is exposed so callers can suppress their own
 * hover behaviour (e.g. a chip's expand) while a drag is in progress.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { animate } from 'animejs'

const HOLD_MS = 180
const MOVE_TOL = 7

function load(key: string, defaults: string[]): string[] {
  try {
    const raw = localStorage.getItem(key)
    if (raw) {
      const got = (JSON.parse(raw) as string[]).filter(x => defaults.includes(x))
      return [...got, ...defaults.filter(x => !got.includes(x))]
    }
  } catch { /* ignore */ }
  return [...defaults]
}

export interface DragOrder {
  order: string[]
  dragging: string | null
  /** while dragging: the id the drop marker should appear BEFORE, or '__end__'
   *  to land after the last item; null when not dragging */
  dropBefore: string | null
  /** spread onto each item's wrapper element */
  itemProps: (id: string) => {
    ref: (el: HTMLElement | null) => void
    onPointerDown: (e: React.PointerEvent) => void
    'data-dragid': string
  }
}

export function useDragOrder(key: string, defaults: string[]): DragOrder {
  const [order, setOrder] = useState<string[]>(() => load(key, defaults))
  const [dragging, setDragging] = useState<string | null>(null)
  const [dropBefore, setDropBefore] = useState<string | null>(null)
  const orderRef = useRef(order); orderRef.current = order

  const els = useRef(new Map<string, HTMLElement>())
  const prevLefts = useRef(new Map<string, number>())
  const flip = useRef(false)
  const insRef = useRef(0)

  useEffect(() => {
    try { localStorage.setItem(key, JSON.stringify(order)) } catch { /* ignore */ }
  }, [key, order])

  // FLIP: animate every item from its previous x to its new x.
  useLayoutEffect(() => {
    if (!flip.current) return
    flip.current = false
    for (const [id, el] of els.current) {
      const before = prevLefts.current.get(id)
      if (before == null) continue
      const dx = before - el.getBoundingClientRect().left
      if (Math.abs(dx) < 1) continue
      animate(el, { translateX: [dx, 0], duration: 360, ease: 'out(3)' })
    }
  }, [order])

  const setRef = useCallback((id: string) => (el: HTMLElement | null) => {
    if (el) els.current.set(id, el); else els.current.delete(id)
  }, [])

  const onPointerDown = (id: string) => (e: React.PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return
    const startX = e.clientX, startY = e.clientY
    const el = els.current.get(id)
    let lifted = false
    let done = false
    let hold: ReturnType<typeof setTimeout> | null = setTimeout(begin, HOLD_MS)

    function begin() {
      hold = null
      lifted = true
      setDragging(id)
      if (el) { el.style.zIndex = '60'; el.style.cursor = 'grabbing'; el.style.willChange = 'transform'; el.style.touchAction = 'none' }
      document.body.style.userSelect = 'none'
      // Once the drag lifts, the dragged item should not also respond to the
      // press (e.g. carousel scroll); the swallow on pointerup handles the click.
    }
    const move = (ev: PointerEvent) => {
      if (!lifted) {
        // Before the hold fires: any move past tolerance means this gesture is a
        // scroll/scrub, not a reorder — abandon so the inner widget keeps it.
        if (Math.abs(ev.clientX - startX) > MOVE_TOL || Math.abs(ev.clientY - startY) > MOVE_TOL) cleanup()
        return
      }
      ev.preventDefault()
      if (el) el.style.transform = `translateX(${ev.clientX - startX}px)`
      const r = el?.getBoundingClientRect()
      const cx = r ? r.left + r.width / 2 : ev.clientX
      let ins = 0
      // Count only RENDERED siblings (els map holds only mounted items) so the
      // insertion index is correct even when some ids are hidden by mode.
      for (const oid of orderRef.current) {
        if (oid === id || !els.current.has(oid)) continue
        const orr = els.current.get(oid)?.getBoundingClientRect()
        if (orr && orr.left + orr.width / 2 < cx) ins++
      }
      insRef.current = ins
      // which rendered item does the marker sit before? ('__end__' = after last)
      const rendered = orderRef.current.filter(x => x !== id && els.current.has(x))
      setDropBefore(rendered[ins] ?? '__end__')
    }
    const commit = () => {
      // Translate the rendered-index drop position into an index in the FULL
      // (incl. hidden) order so hidden ids keep their relative slot.
      const cur = orderRef.current
      const rendered = cur.filter(x => x !== id && els.current.has(x))
      const before = rendered[insRef.current]            // id to land before, or undefined = end
      const without = cur.filter(x => x !== id)
      const at = before == null ? without.length : without.indexOf(before)
      without.splice(at < 0 ? without.length : at, 0, id)
      if (without.some((x, i) => x !== cur[i])) {
        prevLefts.current.clear()
        for (const [eid, e2] of els.current) prevLefts.current.set(eid, e2.getBoundingClientRect().left)
        flip.current = true
        setOrder(without)
      }
    }
    const up = () => {
      if (lifted) {
        if (el) { el.style.transform = ''; el.style.zIndex = ''; el.style.cursor = ''; el.style.willChange = ''; el.style.touchAction = '' }
        document.body.style.userSelect = ''
        // Swallow the click the browser fires right after the drag so the
        // dragged control doesn't also trigger itself (e.g. toggle the theme).
        const swallow = (ce: Event) => { ce.stopPropagation(); ce.preventDefault() }
        window.addEventListener('click', swallow, true)
        setTimeout(() => window.removeEventListener('click', swallow, true), 0)
        commit()
      }
      cleanup()
    }
    // A canceled pointer (OS gesture, lost capture) must tidy up like an up,
    // but without committing a reorder or swallowing a click.
    const cancel = () => {
      if (lifted && el) { el.style.transform = ''; el.style.zIndex = ''; el.style.cursor = ''; el.style.willChange = ''; el.style.touchAction = '' }
      if (lifted) document.body.style.userSelect = ''
      cleanup()
    }
    const cleanup = () => {
      if (done) return
      done = true
      if (hold) { clearTimeout(hold); hold = null }
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      window.removeEventListener('pointercancel', cancel)
      setDragging(null)
      setDropBefore(null)
    }
    window.addEventListener('pointermove', move, { passive: false })
    window.addEventListener('pointerup', up)
    window.addEventListener('pointercancel', cancel)
  }

  const itemProps = (id: string) => ({
    ref: setRef(id),
    onPointerDown: onPointerDown(id),
    'data-dragid': id,
  })

  return { order, dragging, dropBefore, itemProps }
}
