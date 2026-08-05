import { useEffect, useRef, useState } from 'react'
import { animate } from 'animejs'
import { useStore } from '../store.js'
import { call } from '../api.js'
import { playFx } from '../lib/fx.js'
import { C, FONT, D, STR, SP, SZ, FS, FW } from '../constants/index.js'

// jiggle the avatar inside a hovered row (batch helper for all the list rows)
const jiggleAvatar = (e: React.MouseEvent<HTMLElement>) =>
  playFx(e.currentTarget.querySelector('img'), 'jiggle')

const TABS = [
  { value: 'activity',  label: STR.TAB_ACTIVITY },
  { value: 'holders',   label: STR.TAB_HOLDERS },
  { value: 'positions', label: STR.TAB_POSITIONS },
  { value: 'comments',  label: STR.TAB_COMMENTS },
]

// ── Skeleton helpers ──────────────────────────────────────────────────────────

function SkelBox({ w, h, radius = '3px', flex }: { w: string; h: string; radius?: string; flex?: string }) {
  return (
    <div className="tc-skel" style={{
      width: w, height: h, borderRadius: radius,
      flexShrink: flex ? undefined : 0,
      flex: flex,
    }} />
  )
}

function ActivitySkelRow() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: SP.XS, padding: `${SP.XS} ${SP.MD}`, borderBottom: '1px solid var(--tc-border)', width: '100%' }}>
      <SkelBox w={SP.H3} h={SP.H3} radius="50%" />
      <SkelBox w={SZ.S64} h={SP.LG} />
      <SkelBox w={SZ.S46} h={SP.LG} />
      <SkelBox w={SZ.S40} h={SP.LG} />
      <div style={{ flex: 1 }} />
      <SkelBox w={SZ.S28} h={SP.LG} />
    </div>
  )
}

function TwoColSkelRow({ valueW }: { valueW: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: D.GAP_MD, padding: `${SP.XS} ${SP.SM}`, borderBottom: '1px solid var(--tc-border)', width: '100%' }}>
      <SkelBox w={SP.XXL} h={SP.XXL} radius="50%" />
      <SkelBox w="100%" h={SP.LG} flex="1" />
      <SkelBox w={valueW} h={SP.LG} />
    </div>
  )
}

function TwoColSkel({ valueW, rows = 14 }: { valueW: string; rows?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, width: '100%', flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: `${SP.NONE} ${SP.SM} ${SP.XS}` }}>
        <SkelBox w={SZ.S60} h={SP.LG} />
        <SkelBox w={SZ.S44} h={SP.MD} />
      </div>
      {Array.from({ length: rows }).map((_, i) => <TwoColSkelRow key={i} valueW={valueW} />)}
    </div>
  )
}

function HoldersSkel({ rows = 14 }: { rows?: number }) {
  return (
    <div style={{ display: 'flex', gap: D.GAP_MD, width: '100%', padding: `${SP.MD} ${SP.XS}` }}>
      <TwoColSkel valueW={SZ.S36} rows={rows} />
      <div style={{ width: SP.HAIR, background: 'var(--tc-border)', alignSelf: 'stretch' }} />
      <TwoColSkel valueW={SZ.S36} rows={rows} />
    </div>
  )
}

function CommentSkelRow() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP.XS, padding: `${SP.SM} ${SP.MD}`, borderBottom: '1px solid var(--tc-border)', width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: SP.XS, width: '100%' }}>
        <SkelBox w={SP.H3} h={SP.H3} radius="50%" />
        <SkelBox w="80px" h={SP.LG} />
        <div style={{ flex: 1 }} />
        <SkelBox w={SZ.S24} h={SP.MD} />
      </div>
      <SkelBox w="100%" h={SP.LG} />
      <SkelBox w="62%" h={SP.LG} />
    </div>
  )
}

// ── Avatar ────────────────────────────────────────────────────────────────────

function Avatar({ img, color, size = SP.H3 }: { img: string; color: string; size?: string }) {
  if (img) {
    return <img src={img} width={size} height={size} style={{ borderRadius: '50%', objectFit: 'cover', border: '1px solid var(--tc-glass-brd)', flexShrink: 0 }} alt="" />
  }
  return <div style={{ width: size, height: size, borderRadius: '50%', background: color, border: '1px solid var(--tc-glass-brd)', flexShrink: 0 }} />
}

// ── Tab button ────────────────────────────────────────────────────────────────

function TabBtn({ value, label }: { value: string; label: string }) {
  const marketTab = useStore(s => s.market_tab)
  const active = marketTab === value
  return (
    <div
      onClick={() => call('set_market_tab', value)}
      data-spot-for="social"
      data-tab={value}
      onMouseEnter={e => {
        ;(e.currentTarget as HTMLElement).style.backgroundColor = 'var(--tc-up-tint)'
        ;(e.currentTarget as HTMLElement).style.color = C.WHITE
        playFx(e.currentTarget, 'pulse')
      }}
      onMouseLeave={e => {
        ;(e.currentTarget as HTMLElement).style.backgroundColor = ''
        ;(e.currentTarget as HTMLElement).style.color = active ? C.WHITE : C.DIM3
      }}
      style={{
        cursor: 'pointer', position: 'relative', padding: `${SP.SM} ${SP.XXS}`,
        flex: 1, textAlign: 'center', userSelect: 'none',
        color: active ? C.WHITE : C.DIM3,
        transition: 'color var(--tc-dur) var(--tc-ease), background-color var(--tc-dur) var(--tc-ease)',
        fontSize: FS.SM, fontWeight: FW.BOLD, fontFamily: FONT.MONO,
      }}
    >
      {label}
    </div>
  )
}

// ── Content rows ──────────────────────────────────────────────────────────────

type Row = Record<string, unknown>

function ActivityRow({ t }: { t: Row }) {
  const isUp = t['is_up'] as boolean
  const hoverBg = isUp ? 'var(--tc-up-tint)' : 'var(--tc-down-tint)'
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: SP.XS, padding: `${SP.XS} ${SP.MD}`, borderBottom: '1px solid var(--tc-border)', width: '100%', transition: 'background-color var(--tc-dur) var(--tc-ease)' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = hoverBg; jiggleAvatar(e) }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
    >
      <Avatar img={t['img'] as string} color={t['color'] as string} />
      <span style={{ color: C.DIM2, fontWeight: FW.BOLD, fontSize: FS.XS, fontFamily: FONT.MONO, maxWidth: '92px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1 }}>
        {t['name'] as string}
      </span>
      <span style={{ color: C.DIM3, fontSize: FS.XS, fontFamily: FONT.MONO, flexShrink: 0 }}>{t['side'] as string}</span>
      <span style={{ color: isUp ? C.GREEN : C.RED, fontWeight: FW.BOLD, fontSize: FS.XS, fontFamily: FONT.MONO, flexShrink: 0, whiteSpace: 'nowrap' }}>
        {t['size'] as string} {t['outcome'] as string}
      </span>
      <span style={{ color: C.DIM3, fontSize: FS.XS, fontFamily: FONT.MONO, flexShrink: 0, whiteSpace: 'nowrap' }}>@{t['price'] as string}</span>
      <span style={{ color: C.DIM, fontSize: FS.XS, fontFamily: FONT.MONO, flexShrink: 0, whiteSpace: 'nowrap' }}>({t['usd'] as string})</span>
      <div style={{ flex: 1 }} />
      <span style={{ color: C.DIM3, fontSize: FS.XS, fontFamily: FONT.MONO, flexShrink: 0 }}>{t['ago'] as string}</span>
    </div>
  )
}

function HolderRow({ h, color }: { h: Row; color: string }) {
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: SP.MD, padding: `${SP.XS} ${SP.SM}`, borderBottom: '1px solid var(--tc-border)', width: '100%' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--tc-hover)'; jiggleAvatar(e) }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
    >
      <Avatar img={h['img'] as string} color={h['color'] as string} size={SP.XXL} />
      <span style={{ color: C.DIM2, fontSize: FS.XS, fontWeight: FW.SEMI, fontFamily: FONT.MONO, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 }}>
        {h['name'] as string}
      </span>
      <span style={{ color, fontSize: FS.XS, fontWeight: FW.BOLD, fontFamily: FONT.MONO, flexShrink: 0 }}>
        {h['shares'] as string}
      </span>
    </div>
  )
}

function HoldersCol({ title, rows, color }: { title: string; rows: Row[]; color: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: `${SP.NONE} ${SP.SM} ${SP.XS}` }}>
        <span style={{ color: C.WHITE, fontSize: FS.XS, fontWeight: FW.XBOLD, fontFamily: FONT.MONO }}>{title}</span>
        <span style={{ color: C.DIM, fontSize: FS.NANO, fontWeight: FW.BOLD, fontFamily: FONT.MONO }}>{STR.COL_SHARES}</span>
      </div>
      {rows.map((h, i) => <HolderRow key={i} h={h} color={color} />)}
    </div>
  )
}

function PosLbRow({ p }: { p: Row }) {
  const pnlPos = p['pnl_pos'] as boolean
  const hoverBg = pnlPos ? 'var(--tc-up-tint)' : 'var(--tc-down-tint)'
  return (
    <div
      style={{ display: 'flex', alignItems: 'center', gap: SP.MD, padding: `${SP.XS} ${SP.SM}`, borderBottom: '1px solid var(--tc-border)', width: '100%' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = hoverBg; jiggleAvatar(e) }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
    >
      <Avatar img={p['img'] as string} color={p['color'] as string} size={SP.XXL} />
      <span style={{ color: C.DIM2, fontSize: FS.XS, fontWeight: FW.SEMI, fontFamily: FONT.MONO, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {p['name'] as string}
      </span>
      <span style={{ color: pnlPos ? C.GREEN : C.RED, fontSize: FS.XS, fontWeight: FW.BOLD, fontFamily: FONT.MONO, flexShrink: 0 }}>
        {p['pnl'] as string}
      </span>
    </div>
  )
}

function PosLbCol({ title, rows }: { title: string; rows: Row[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minWidth: 0 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', padding: `${SP.NONE} ${SP.SM} ${SP.XS}` }}>
        <span style={{ color: C.WHITE, fontSize: FS.XS, fontWeight: FW.XBOLD, fontFamily: FONT.MONO }}>{title}</span>
        <span style={{ color: C.DIM, fontSize: FS.NANO, fontWeight: FW.BOLD, fontFamily: FONT.MONO }}>{STR.COL_PNL}</span>
      </div>
      {rows.map((p, i) => <PosLbRow key={i} p={p} />)}
    </div>
  )
}

function CommentRow({ c }: { c: Row }) {
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: SP.XS, padding: `${SP.SM} ${SP.MD}`, borderBottom: '1px solid var(--tc-border)', width: '100%' }}
      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.backgroundColor = 'var(--tc-hover)'; jiggleAvatar(e) }}
      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.backgroundColor = '' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: SP.XS, width: '100%' }}>
        <Avatar img={c['img'] as string} color={c['color'] as string} />
        <span style={{ color: C.DIM2, fontWeight: FW.BOLD, fontSize: FS.XS, fontFamily: FONT.MONO, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1 }}>
          {c['name'] as string}
        </span>
        <span style={{ color: C.DIM, fontSize: FS.XXS, fontFamily: FONT.MONO, flexShrink: 0 }}>{c['ago'] as string}</span>
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: FS.XXS, fontFamily: FONT.MONO, color: C.DIM, flexShrink: 0, display: 'flex', alignItems: 'center', gap: SP.XXS }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke={C.DIM} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>
          {c['likes'] as string}
        </span>
      </div>
      <span style={{ color: C.WHITE, fontSize: FS.SM, fontFamily: FONT.MONO, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>
        {c['body'] as string}
      </span>
    </div>
  )
}

// ── Empty state ───────────────────────────────────────────────────────────────

function Empty({ text }: { text: string }) {
  return (
    <div style={{ width: '100%', padding: `28px ${SP.XL}`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <span style={{ color: C.DIM, fontSize: FS.SM, fontFamily: FONT.MONO, textAlign: 'center', whiteSpace: 'pre-line' }}>{text}</span>
    </div>
  )
}

// ── Tab content ───────────────────────────────────────────────────────────────

function TabContent() {
  const marketTab = useStore(s => s.market_tab)
  const mktTrades = useStore(s => s.mkt_trades)
  const mktUpHolders = useStore(s => s.mkt_up_holders)
  const mktDnHolders = useStore(s => s.mkt_dn_holders)
  const mktComments = useStore(s => s.mkt_comments)
  const mktUpPos = useStore(s => s.mkt_up_pos)
  const mktDnPos = useStore(s => s.mkt_dn_pos)
  const posLbLoading = useStore(s => s.pos_lb_loading)
  const socialLoaded = useStore(s => s.social_loaded_cid)
  const socialFullCid = useStore(s => s.social_full_cid)

  // Positions leaderboard is fetched on demand — trigger it when the tab is
  // opened (and refetch when the viewed market changes while on the tab).
  // posSettled gates the "No positions" empty state so it only shows once a
  // fetch has actually returned empty — never as a first-frame flash.
  const [posSettled, setPosSettled] = useState(false)
  useEffect(() => {
    if (marketTab === 'positions' && socialLoaded) {
      setPosSettled(false)
      call('fetch_positions_leaderboard').finally(() => setPosSettled(true))
    }
  }, [marketTab, socialLoaded])

  // Use social_loaded_cid as proxy for social_ready (trades landed → Activity live)
  const socialReady = !!socialLoaded
  // Holders/Comments load separately and may lag or transiently fail; keep them on
  // a skeleton until the server reports the market FULLY loaded, so they never flash
  // a premature "No holders/comments" while a fetch is still in flight / retrying.
  const socialFull = !!socialFullCid && socialFullCid === socialLoaded

  if (!socialReady) {
    if (marketTab === 'holders' || marketTab === 'positions') return <HoldersSkel />
    if (marketTab === 'comments') return <>{Array.from({ length: 11 }).map((_, i) => <CommentSkelRow key={i} />)}</>
    return <>{Array.from({ length: 18 }).map((_, i) => <ActivitySkelRow key={i} />)}</>
  }

  if (marketTab === 'holders') {
    if (!mktUpHolders.length && !mktDnHolders.length) return socialFull ? <Empty text={STR.NO_HOLDERS} /> : <HoldersSkel />
    return (
      <div className="tc-fadein" style={{ display: 'flex', gap: D.GAP_MD, width: '100%', padding: `${SP.MD} ${SP.XS}` }}>
        <HoldersCol title={STR.HOLDERS_UP} rows={mktUpHolders} color={C.GREEN} />
        <div style={{ width: SP.HAIR, background: 'var(--tc-border)', alignSelf: 'stretch' }} />
        <HoldersCol title={STR.HOLDERS_DOWN} rows={mktDnHolders} color={C.RED} />
      </div>
    )
  }

  if (marketTab === 'positions') {
    if (!mktUpPos.length && !mktDnPos.length) {
      if (posLbLoading || !posSettled) return <HoldersSkel rows={14} />
      return <Empty text={STR.NO_POSITIONS_W} />
    }
    return (
      <div className="tc-fadein" style={{ display: 'flex', gap: D.GAP_MD, width: '100%', padding: `${SP.MD} ${SP.XS}` }}>
        <PosLbCol title={STR.UP} rows={mktUpPos} />
        <div style={{ width: SP.HAIR, background: 'var(--tc-border)', alignSelf: 'stretch' }} />
        <PosLbCol title={STR.DOWN} rows={mktDnPos} />
      </div>
    )
  }

  if (marketTab === 'comments') {
    if (!mktComments.length) return socialFull ? <Empty text={STR.NO_COMMENTS} /> : <>{Array.from({ length: 11 }).map((_, i) => <CommentSkelRow key={i} />)}</>
    return (
      <div className="tc-fadein" style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
        {mktComments.map((c, i) => <CommentRow key={i} c={c} />)}
      </div>
    )
  }

  // Default: activity
  if (!mktTrades.length) return <Empty text={STR.NO_TRADES} />
  return (
    <div className="tc-fadein" style={{ display: 'flex', flexDirection: 'column', width: '100%' }}>
      {mktTrades.map((t, i) => <ActivityRow key={i} t={t} />)}
    </div>
  )
}

// ── IntersectionObserver infinite scroll sentinel ─────────────────────────────

function InfScrollSentinel({ onVisible }: { onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(entries => {
      if (entries[0]?.isIntersecting) onVisible()
    }, { rootMargin: '240px' })
    io.observe(el)
    return () => io.disconnect()
  }, [onVisible])
  return <div ref={ref} style={{ height: SP.HAIR, width: '100%' }} />
}

// ── Load more footer ──────────────────────────────────────────────────────────

function LoadMoreFooter() {
  const feedLoadingMore = useStore(s => s.feed_loading_more)
  const marketTab = useStore(s => s.market_tab)

  // Only the Activity feed paginates (load_more_feed fetches more trades).
  // Holders/Positions are fixed leaderboards and Comments isn't paginated —
  // rendering the sentinel there caused a perpetual skeleton flicker that
  // loaded the wrong data and never grew the list.
  if (marketTab !== 'activity') return null

  return (
    <>
      {feedLoadingMore && <>{[0,1,2].map(i => <ActivitySkelRow key={i} />)}</>}
      <InfScrollSentinel onVisible={() => call('load_more_feed')} />
    </>
  )
}

// ── MarketPanel ───────────────────────────────────────────────────────────────

export function MarketPanel() {
  const socialLoaded = useStore(s => s.social_loaded_cid)
  const socialReady = !!socialLoaded
  const marketTab = useStore(s => s.market_tab)

  const stripRef = useRef<HTMLDivElement>(null)
  const indRef = useRef<HTMLDivElement>(null)
  const firstRef = useRef(true)

  // Slide the green underline to the active tab (anime.js).
  useEffect(() => {
    const strip = stripRef.current, ind = indRef.current
    if (!strip || !ind) return
    const tab = strip.querySelector(`[data-tab="${marketTab}"]`) as HTMLElement | null
    if (!tab) return
    const left = tab.offsetLeft + 8, w = tab.offsetWidth - 16
    if (firstRef.current) {
      ind.style.left = `${left}px`; ind.style.width = `${w}px`; ind.style.opacity = '1'
      firstRef.current = false
      return
    }
    animate(ind, { left: `${left}px`, width: `${w}px`, duration: 300, ease: 'out(3)' })
  }, [marketTab])

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', width: '100%', height: '100%', minHeight: 0,
      overflow: 'hidden', background: 'var(--tc-panel)',
      border: '1px solid var(--tc-border)', borderRadius: D.R_CARD, boxShadow: 'var(--tc-elev-1)',
    }}>
      {/* Tab strip */}
      <div ref={stripRef} style={{
        position: 'relative',
        display: 'flex', gap: 0, width: '100%', flexShrink: 0,
        borderBottom: '1px solid var(--tc-border)',
        background: 'var(--tc-card)',
        backgroundImage: 'var(--tc-grad-card)',
      }}>
        {TABS.map(t => <TabBtn key={t.value} value={t.value} label={t.label} />)}
        {/* sliding green underline */}
        <div ref={indRef} style={{
          position: 'absolute', bottom: 0, left: 0, width: 0, height: SP.XXS, opacity: 0,
          borderRadius: '2px 2px 0 0', background: C.GREEN, boxShadow: 'var(--tc-glow-up)',
          pointerEvents: 'none',
        }} />
      </div>

      {/* Scrollable content + infinite scroll sentinel */}
      <div style={{
        width: '100%', flex: 1, minHeight: 0, overflowY: 'auto',
        scrollbarWidth: 'thin', overscrollBehavior: 'contain',
      }}>
        <TabContent />
        {socialReady && <LoadMoreFooter />}
      </div>
    </div>
  )
}
