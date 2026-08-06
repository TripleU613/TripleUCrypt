import { useStore } from '../../store.js'
import { C, FONT, D, SP, FS, FW } from '../../constants/index.js'

interface AskTileProps {
  upToken: string
  dnToken: string
  vertical?: boolean   // stack UP over DOWN instead of side-by-side
}

export function AskTile({ upToken, dnToken, vertical = false }: AskTileProps) {
  const fmt = (v: number) => (v > 0 ? v.toFixed(1) + '¢' : '—')
  // ONE number per selector, never the token_asks map: selecting the map would
  // re-render this tile whenever ANY of the ~28 streamed tokens moved. The
  // server already gates its patches on a >0.05¢ move, so no local threshold.
  const up = useStore(s => (upToken ? s.token_asks[upToken] ?? 0 : 0))
  const dn = useStore(s => (dnToken ? s.token_asks[dnToken] ?? 0 : 0))

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
