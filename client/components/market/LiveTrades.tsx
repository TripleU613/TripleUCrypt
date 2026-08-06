import { useRef, useEffect, useState } from 'react'
import { useStore, type ActivityEntry } from '../../store.js'
import { C, FONT, D, SP, FS, FW, STR } from '../../constants/index.js'

/**
 * Scrolling cross-market activity log.
 *
 * This used to consume the Polymarket RTDS firehose directly in the browser and
 * format every frame itself. The server does that now (src/engine/activity.ts)
 * and ships the finished rows in state.activity, newest first, capped at 60 and
 * coalesced to ~3 patches/sec — which is why there is no local flush timer any
 * more; the batching happens upstream.
 *
 * The server's cap is a bandwidth knob, not the scrollback: we accumulate every
 * id we haven't seen yet so the log keeps a much longer local history than the
 * 60 rows any single patch carries.
 */

/** Per-kind presentation. `up` only exists on trades. */
function look(e: ActivityEntry): { tag: string; tagColor: string; textColor: string } {
  if (e.kind === 'trade') {
    const col = e.up ? C.GREEN : C.RED
    return { tag: STR.TAG_TRADE, tagColor: col, textColor: col }
  }
  if (e.kind === 'chat') {
    return { tag: STR.TAG_CHAT, tagColor: C.BTC, textColor: 'var(--tc-text-2)' }
  }
  return { tag: STR.TAG_PRICE, tagColor: 'var(--tc-dim2)', textColor: 'var(--tc-text-2)' }
}

export function LiveTrades() {
  const activity = useStore(s => s.activity)
  const [rows, setRows] = useState<ActivityEntry[]>([])
  const lastId = useRef(0)
  const scroller = useRef<HTMLDivElement>(null)

  // Smooth auto-scroll to bottom
  useEffect(() => {
    let raf: number
    const step = () => {
      const el = scroller.current
      if (el) {
        const max = el.scrollHeight - el.clientHeight
        if (max > 0 && el.scrollTop < max - 0.5)
          el.scrollTop = Math.min(max, el.scrollTop + Math.max(0.5, (max - el.scrollTop) * 0.08))
      }
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    if (!activity.length) return
    // Ids are server-side monotonic and reset to 0 when the server restarts, so
    // an id below the high-water mark means a fresh server, not a stale patch:
    // drop the old scrollback rather than silently ignoring everything after.
    if (activity[0].id < lastId.current) {
      lastId.current = 0
      setRows([])
    }
    // Newest first upstream; take the unseen head and flip it oldest-first
    // because this log grows downwards.
    const fresh: ActivityEntry[] = []
    for (const e of activity) {
      if (e.id <= lastId.current) break
      fresh.push(e)
    }
    if (!fresh.length) return
    lastId.current = fresh[0].id
    fresh.reverse()
    setRows(prev => {
      const next = [...prev, ...fresh]
      return next.length > 260 ? next.slice(next.length - 200) : next
    })
  }, [activity])

  return (
    <div style={{
      width: '100%', height: '100%', overflow: 'hidden',
      background: 'var(--tc-panel)', border: '1px solid var(--tc-border)',
      borderRadius: D.R_CARD, boxShadow: 'var(--tc-elev-1)',
    }}>
      <div ref={scroller} style={{
        display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
        overflowY: 'hidden', overflowX: 'hidden', overscrollBehavior: 'contain',
        WebkitMaskImage: 'linear-gradient(180deg, transparent 0, black 26px)',
        maskImage: 'linear-gradient(180deg, transparent 0, black 26px)',
      }}>
        {rows.map(r => {
          const { tag, tagColor, textColor } = look(r)
          return (
            <div key={r.id} style={{
              display: 'flex', alignItems: 'center', gap: SP.XS,
              padding: `${SP.NONE} ${SP.MD}`, height: SP.XXL, lineHeight: '15px', flexShrink: 0,
              fontFamily: FONT.MONO,
              fontSize: FS.XXS, whiteSpace: 'nowrap',
            }}>
              <span style={{ color: 'var(--tc-dim3)', flexShrink: 0 }}>{r.t}</span>
              <span style={{ color: tagColor, fontWeight: FW.XBOLD, flexShrink: 0, fontSize: '0.52rem', letterSpacing: '0.04em' }}>{tag}</span>
              <span style={{ color: textColor, overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}>{r.text}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
