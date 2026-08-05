import { useRef, useEffect, useState } from 'react'
import { sub } from '../../buses/RtdsBus.js'
import { C, FONT, D, SP, FS, FW, STR } from '../../constants/index.js'

interface LogRow { id: number; t: string; tag: string; tagColor: string; text: string; textColor: string }

export function LiveTrades() {
  const [rows, setRows] = useState<LogRow[]>([])
  const buf = useRef<LogRow[]>([])
  const idc = useRef(0)
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
    let closed = false
    const GREEN = C.GREEN, RED = C.RED, GOLD = C.BTC

    const clk = () => {
      const d = new Date()
      const p = (n: number) => String(n).padStart(2, '0')
      return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`
    }
    const money = (n: number) => n >= 1000 ? Math.round(n).toLocaleString() : n.toFixed(2)
    const push = (tag: string, tagColor: string, text: string, textColor: string) => {
      buf.current.push({ id: idc.current++, t: clk(), tag, tagColor, text, textColor })
    }

    const flush = setInterval(() => {
      if (closed || !buf.current.length) return
      const add = buf.current.splice(0, buf.current.length)
      setRows(prev => {
        const next = [...prev, ...add]
        return next.length > 260 ? next.slice(next.length - 200) : next
      })
    }, 150)

    const handle = (m: unknown) => {
      const msg = m as Record<string, unknown>
      const topic = (msg?.topic as string) ?? ''
      const p = (msg?.payload ?? msg) as Record<string, unknown>
      if (!p) return

      if (topic === 'crypto_prices_chainlink' || p['symbol']) {
        const sym = String(p['symbol'] ?? '').split('/')[0].toUpperCase()
        const v = parseFloat(String(p['value'] ?? ''))
        if (sym && !isNaN(v)) push(STR.TAG_PRICE, 'var(--tc-dim2)', `${sym} $${money(v)}`, 'var(--tc-text-2)')
        return
      }
      if (p['side'] || p['outcome']) {
        const up = String(p['outcome'] ?? '').toLowerCase() === 'up'
        const amt = (parseFloat(String(p['size'] ?? 0)) * parseFloat(String(p['price'] ?? 0))) || 0
        const prof = (p['profile'] ?? {}) as Record<string, unknown>
        const who = String(p['name'] ?? prof['name'] ?? prof['pseudonym'] ?? String(p['proxyWallet'] ?? '').slice(0, 6) + '…')
        const verb = String(p['side'] ?? '').toUpperCase() === 'SELL' ? 'sold' : 'bought'
        push(STR.TAG_TRADE, up ? GREEN : RED, `${who} ${verb} ${up ? 'Up' : 'Down'} $${money(amt)}`, up ? GREEN : RED)
        return
      }
      const prof = (p['profile'] ?? p) as Record<string, unknown>
      if (p['body'] || (prof['name'] && topic === 'comments')) {
        const who = String(prof['name'] ?? prof['pseudonym'] ?? STR.ANON)
        push(STR.TAG_CHAT, GOLD, `${who}: ${String(p['body'] ?? '').slice(0, 60)}`, 'var(--tc-text-2)')
      }
    }

    const unsub = sub((arr) => {
      if (closed) return
      for (const x of arr) { try { handle(x) } catch { /* ignore malformed */ } }
      if (buf.current.length > 120) buf.current.splice(0, buf.current.length - 120)
    })

    return () => { closed = true; clearInterval(flush); unsub() }
  }, [])

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
        {rows.map(r => (
          <div key={r.id} style={{
            display: 'flex', alignItems: 'center', gap: SP.XS,
            padding: `${SP.NONE} ${SP.MD}`, height: SP.XXL, lineHeight: '15px', flexShrink: 0,
            fontFamily: FONT.MONO,
            fontSize: FS.XXS, whiteSpace: 'nowrap',
          }}>
            <span style={{ color: 'var(--tc-dim3)', flexShrink: 0 }}>{r.t}</span>
            <span style={{ color: r.tagColor, fontWeight: FW.XBOLD, flexShrink: 0, fontSize: '0.52rem', letterSpacing: '0.04em' }}>{r.tag}</span>
            <span style={{ color: r.textColor, overflow: 'hidden', textOverflow: 'ellipsis', flex: 1, minWidth: 0 }}>{r.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
