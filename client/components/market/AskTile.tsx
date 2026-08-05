import { useRef, useEffect, useState } from 'react'
import { sub } from '../../buses/ClobBus.js'
import { C, FONT, D, SP, FS, FW } from '../../constants/index.js'

interface AskTileProps {
  upToken: string
  dnToken: string
  upSeed: number
  dnSeed: number
  vertical?: boolean   // stack UP over DOWN instead of side-by-side
}

export function AskTile({ upToken, dnToken, upSeed, dnSeed, vertical = false }: AskTileProps) {
  const fmt = (v: number) => (v > 0 ? v.toFixed(1) + '¢' : '—')
  const [up, setUp] = useState(upSeed > 0 ? upSeed : 0)
  const [dn, setDn] = useState(dnSeed > 0 ? dnSeed : 0)
  const upRef = useRef(upSeed > 0 ? upSeed : 0)
  const dnRef = useRef(dnSeed > 0 ? dnSeed : 0)

  useEffect(() => { if (!(upRef.current > 0) && upSeed > 0) { upRef.current = upSeed; setUp(upSeed) } }, [upSeed])
  useEffect(() => { if (!(dnRef.current > 0) && dnSeed > 0) { dnRef.current = dnSeed; setDn(dnSeed) } }, [dnSeed])

  useEffect(() => {
    if (!upToken && !dnToken) return
    upRef.current = upSeed > 0 ? upSeed : 0
    dnRef.current = dnSeed > 0 ? dnSeed : 0
    setUp(upRef.current); setDn(dnRef.current)
    const unsub = sub([upToken, dnToken], (token, ask) => {
      if (ask == null || isNaN(ask)) return
      if (token === upToken) {
        if (Math.abs(ask - upRef.current) > 0.05) { upRef.current = ask; setUp(ask) }
      } else if (token === dnToken) {
        if (Math.abs(ask - dnRef.current) > 0.05) { dnRef.current = ask; setDn(ask) }
      }
    })
    return unsub
  }, [upToken, dnToken])

  const chip = (has: boolean, txt: string, color: string, arrow: string) => (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: SP.XXS, justifyContent: 'center', width: '100%' }}>
      {has ? <>
        <span style={{ color, fontSize: FS.NANO, fontWeight: FW.BLACK, lineHeight: 1 }}>{arrow}</span>
        <span key={txt} className="tc-tick"
              style={{ color, fontSize: FS.MD, fontWeight: FW.XBOLD,
                       fontFamily: FONT.MONO,
                       lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{txt}</span>
      </> : <span style={{ color: 'var(--tc-dim)', fontSize: FS.XS,
                           fontFamily: FONT.MONO }}>—</span>}
    </span>
  )

  const cell: React.CSSProperties = {
    flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
    border: '1px solid var(--tc-active)', borderRadius: D.R_SM,
    width: '100%', padding: vertical ? SP.NONE : `${SP.SM} 0`,
    transition: 'background-color var(--tc-dur) var(--tc-ease)',
  }

  return (
    <div style={{ display: 'flex', flexDirection: vertical ? 'column' : 'row',
                  gap: SP.XS, width: '100%', height: '100%' }}>
      <div style={{ ...cell, background: 'var(--tc-up-tint)' }}>{chip(up > 0, fmt(up), C.GREEN, '▲')}</div>
      <div style={{ ...cell, background: 'var(--tc-down-tint)' }}>{chip(dn > 0, fmt(dn), C.RED, '▼')}</div>
    </div>
  )
}
