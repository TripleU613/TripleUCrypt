import React, { useEffect, useRef, useState } from 'react'
import { animate, scrambleText, spring, stagger, utils } from 'animejs'
import { useStore } from './store.js'
import { call } from './api.js'
import { Nav } from './components/Nav.js'
import { ChartView } from './components/ChartView.js'
import { TradingBar } from './components/TradingBar.js'
import { MarketPanel } from './components/MarketPanel.js'
import { WalletPanel } from './components/WalletPanel.js'
import { LeftDock } from './components/left/LeftDock.js'
import { MobileApp } from './components/mobile/MobileApp.js'
import { Toasts } from './components/Toasts.js'
import { playFx } from './lib/fx.js'
import { tryReconnect } from './buses/MetaMaskBus.js'
import { refreshBrowserPortfolio } from './buses/ClobTrade.js'
import { FONT, C, D, MS, Z, STR, BP } from './constants/index.js'

// ── FPS reporter — measures real browser frame rate and reports to server ────
// Server's power manager uses this to downgrade the performance tier on drops.
// Samples over a 2-second window; reports at most once per window.
function useFpsReporter() {
  useEffect(() => {
    let frames = 0
    let windowStart = performance.now()
    let raf = 0

    function tick() {
      frames++
      const now = performance.now()
      if (now - windowStart >= MS.FPS_WINDOW) {
        const fps = Math.round((frames / (now - windowStart)) * 1000)
        call('report_fps', fps)
        frames = 0
        windowStart = now
      }
      raf = requestAnimationFrame(tick)
    }

    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [])
}

// ── Dead-state detection ──────────────────────────────────────────────────────
// Mirrors the Python watchdog: if clock_tick hasn't changed in >12s, the
// connection is dead. The data-conn="dead" attribute on <html> drives the CSS
// overlay (already in theme.ts) and dims the app root.

function useDeadState(): boolean {
  const clockTick = useStore((s) => s.clock_tick)
  const [dead, setDead] = useState(false)
  const lastTickRef = useRef(Date.now())
  const seenRef = useRef(false)

  // Stamp the last time we saw a tick change
  useEffect(() => {
    if (clockTick !== 0 || seenRef.current) {
      lastTickRef.current = Date.now()
      seenRef.current = true
      setDead(false)
    }
  }, [clockTick])

  // Poll every second to check staleness
  useEffect(() => {
    const id = setInterval(() => {
      if (!seenRef.current) return
      if (document.visibilityState === 'hidden') return
      setDead(Date.now() - lastTickRef.current > MS.DEAD_MS)
    }, MS.CLOCK_POLL)
    return () => clearInterval(id)
  }, [])

  return dead
}

// ── App-readiness gate ────────────────────────────────────────────────────────
// The boot overlay stays up until the app is actually loaded AND functioning —
// connected, markets in, a live price ticking, the buy panel priced, the chart
// drawn, the scoreboard populated, and the social panel loaded. Each subsystem
// is an independent async stream, so we wait for all of them.
//
// Two safeguards keep this from trapping the user:
//   • latch — once ready, it stays ready (a later transient drop is handled by
//     the connection banner / dead-state overlay, not by re-showing boot).
//   • fallback — once the essentials (connected + markets) are in, we give the
//     remaining streams a grace period, then reveal anyway so one slow/empty
//     feed (e.g. a market with no comments) can't pin the loading screen.
function useAppReady(): boolean {
  const connected = useStore((s) => s._connected)
  const windowsLen = useStore((s) => s.windows.length)
  const clPrice = useStore((s) => s.cl_price)
  const btcPrice = useStore((s) => s.btc_price)
  const upAsk = useStore((s) => s.up_ask)
  const dnAsk = useStore((s) => s.dn_ask)
  const combined = useStore((s) => s.combined)
  const candlesLen = useStore((s) => s.window_candles_1m.length)
  const statsFresh = useStore((s) => s.stats_fresh)
  const socialLoaded = useStore((s) => s.social_loaded_cid)

  const essentials = connected && windowsLen > 0
  const livePrice = clPrice > 0 || btcPrice > 0
  const priced = upAsk > 0 || dnAsk > 0 || combined > 0
  const charted = candlesLen > 0
  const fullyReady =
    essentials && livePrice && priced && charted && statsFresh && !!socialLoaded

  const [ready, setReady] = useState(false)
  const [fallbackHit, setFallbackHit] = useState(false)

  // Grace-period fallback: start the clock once essentials are in.
  useEffect(() => {
    if (!essentials || ready) return
    const t = setTimeout(() => setFallbackHit(true), MS.BOOT_FALLBACK)
    return () => clearTimeout(t)
  }, [essentials, ready])

  useEffect(() => {
    if (ready) return
    if (fullyReady || (essentials && fallbackHit)) setReady(true)
  }, [ready, fullyReady, essentials, fallbackHit])

  return ready
}

// ── Boot overlay ──────────────────────────────────────────────────────────────
// Three acts:
//   1. decrypt — the wordmark scrambles into "TripleUCrypt" (always plays fully)
//   2. loading — a slow up/down spring bounce in the middle; shown for at least
//                BOOT_LOADING_MIN (2s), and longer while still waiting on ready
//   3. explode — fires the instant the app reports ready (no artificial delay;
//                it's just an overlay): the word + Polymarket mark burst into
//                pieces while the app underneath unblurs into focus — together
const BOOT_WORD = 'TripleUCrypt'

// The Polymarket cube mark (single filled path, viewBox 0 0 512 512) — lifted
// from public/polymarket-icon.svg so the boot screen can animate it inline.
const POLY_PATH =
  'M375.84 389.422C375.84 403.572 375.84 410.647 371.212 414.154C366.585 417.662 359.773 415.75 346.15 411.927L127.22 350.493C119.012 348.19 114.907 347.038 112.534 343.907C110.161 340.776 110.161 336.513 110.161 327.988V184.012C110.161 175.487 110.161 171.224 112.534 168.093C114.907 164.962 119.012 163.81 127.22 161.507L346.15 100.072C359.773 96.2495 366.585 94.338 371.212 97.8455C375.84 101.353 375.84 108.428 375.84 122.578V389.422ZM164.761 330.463L346.035 381.337V279.595L164.761 330.463ZM139.963 306.862L321.201 256L139.963 205.138V306.862ZM164.759 181.537L346.035 232.406V130.663L164.759 181.537Z'

function BootOverlay({ ready, onUnveil }: { ready: boolean; onUnveil: () => void }) {
  const overlayRef = useRef<HTMLDivElement>(null)
  const wordRef = useRef<HTMLSpanElement>(null)
  const particleRef = useRef<HTMLDivElement>(null)
  const polySvgRef = useRef<SVGSVGElement>(null)
  const shardRef = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(true)

  const readyRef = useRef(ready)
  readyRef.current = ready
  const lettersReadyRef = useRef(false)
  const explodedRef = useRef(false)
  const explodeScheduledRef = useRef(false)
  const bounceStartRef = useRef(0)
  const bounceRef = useRef<ReturnType<typeof animate> | null>(null)
  const logoLoopRef = useRef<ReturnType<typeof animate> | null>(null)
  const reduceRef = useRef(false)

  // Request the explosion once the app is ready — but hold it until the up/down
  // "loading" bounce has run for at least BOOT_LOADING_MIN, so the middle act is
  // always given its beat (no flash-through on a warm/instant-ready server).
  // No-ops until the decrypt has produced the letters (its onComplete retries).
  const requestExplode = () => {
    if (explodedRef.current || explodeScheduledRef.current) return
    if (reduceRef.current) { explode(); return }
    if (!lettersReadyRef.current) return
    explodeScheduledRef.current = true
    const shown = performance.now() - bounceStartRef.current
    setTimeout(() => explode(), Math.max(0, MS.BOOT_LOADING_MIN - shown))
  }

  // Act 3 — bursts the word + logo into pieces AND tells the app to unblur, so
  // the curtain dissolves while the live app snaps into focus — together, same
  // frame. Idempotent: only the first call fires.
  const explode = () => {
    if (explodedRef.current) return
    if (!reduceRef.current && !lettersReadyRef.current) return // wait for decrypt
    explodedRef.current = true
    onUnveil()  // unblur the app underneath, in lockstep with the explosion
    try { bounceRef.current?.pause() } catch { /* ignore */ }
    try { logoLoopRef.current?.pause() } catch { /* ignore */ }

    if (!reduceRef.current) {
      // the Polymarket mark shatters — a quick recoil then it bursts apart while
      // a spray of shards flies out from its centre
      if (polySvgRef.current) {
        animate(polySvgRef.current, {
          scale: [{ to: 1.25, duration: 130 }, { to: 0, duration: 520 }],
          rotate: () => utils.random(-90, 90),
          opacity: [{ to: 1, duration: 130 }, { to: 0, duration: 430 }],
          duration: 650,
          ease: 'out(4)',
        })
      }
      const shardLayer = shardRef.current
      if (shardLayer) {
        for (let i = 0; i < 34; i++) {
          const s = document.createElement('div')
          s.className = 'tc-boot-shard'
          shardLayer.appendChild(s)
          animate(s, {
            x: utils.random(-13, 13, 2) + 'rem',
            y: utils.random(-13, 13, 2) + 'rem',
            rotate: () => utils.random(-360, 360),
            scale: [{ from: utils.random(0.7, 1.3, 2) }, { to: 0 }],
            opacity: [{ from: 1 }, { to: 0 }],
            delay: utils.random(0, 140),
            duration: utils.random(560, 920),
            ease: 'out(3)',
          })
        }
      }
      const chars = wordRef.current?.querySelectorAll('.tc-boot-char')
      if (chars && chars.length) {
        animate(chars, {
          x: () => utils.random(-26, 26, 1) + 'rem',
          y: () => utils.random(-15, 15, 1) + 'rem',
          rotate: () => utils.random(-220, 220),
          scale: [{ to: 1.5, duration: 150 }, { to: 0, duration: 600 }],
          opacity: [{ to: 1, duration: 120 }, { to: 0, duration: 640 }],
          delay: stagger(26),
          ease: 'out(3)',
          duration: 780,
        })
      }
      const layer = particleRef.current
      if (layer) {
        for (let i = 0; i < 90; i++) {
          const p = document.createElement('div')
          p.className = 'tc-boot-particle'
          layer.appendChild(p)
          animate(p, {
            x: utils.random(-32, 32, 2) + 'rem',
            y: utils.random(-19, 19, 2) + 'rem',
            scale: [{ from: 0, to: utils.random(0.5, 1.4, 2) }, { to: 0 }],
            opacity: [{ from: 1 }, { to: 0 }],
            delay: utils.random(0, 240),
            duration: utils.random(620, 1040),
            ease: 'out(3)',
          })
        }
      }
    }

    if (overlayRef.current) {
      animate(overlayRef.current, {
        opacity: [1, 0],
        duration: reduceRef.current ? 450 : 900,
        ease: 'inOut(2)',
        delay: reduceRef.current ? 0 : 170,
      })
    }
    setTimeout(() => setMounted(false), reduceRef.current ? 480 : MS.BOOT_BURST)
  }

  // Act 1 + 2 — scramble in, split into letters, then a slow spring bounce wave.
  useEffect(() => {
    reduceRef.current = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const el = wordRef.current
    if (!el) return

    if (reduceRef.current) {
      el.textContent = BOOT_WORD
      lettersReadyRef.current = true
      if (readyRef.current) explode()
      return
    }

    // The Polymarket mark spins in, then breathes with a slow pulse while we
    // wait (≥1s per pulse) until the explosion blasts it off.
    if (polySvgRef.current) {
      animate(polySvgRef.current, {
        rotate: [-180, 0],
        scale: [0, 1],
        opacity: [0, 1],
        duration: 900,
        ease: 'out(4)',
        onComplete: () => {
          if (explodedRef.current || !polySvgRef.current) return
          logoLoopRef.current = animate(polySvgRef.current, {
            scale: [1, 1.08, 1],
            duration: 1600,
            ease: 'inOutSine',
            loop: true,
          })
        },
      })
    }

    el.textContent = ''
    const intro = animate(el, {
      innerHTML: scrambleText({ text: BOOT_WORD, chars: 'uppercase' }),
      duration: MS.BOOT_SCRAMBLE,
      ease: 'linear',
      onComplete: () => {
        el.innerHTML = BOOT_WORD.split('')
          .map(c => `<span class="tc-boot-char">${c}</span>`)
          .join('')
        lettersReadyRef.current = true
        const chars = el.querySelectorAll('.tc-boot-char')
        bounceStartRef.current = performance.now()
        bounceRef.current = animate(chars, {
          y: [0, -15, 0],
          ease: spring({ stiffness: 90, damping: 9 }),
          delay: stagger(70),
          loop: true,
          loopDelay: 850,            // slow, recurring wave
        })
        // If the app already reported ready during the decrypt, queue the burst
        // now — it still waits out the 2s loading-bounce minimum.
        if (readyRef.current) requestExplode()
      },
    })
    return () => {
      try { intro.revert() } catch { /* ignore */ }
      try { bounceRef.current?.revert() } catch { /* ignore */ }
      try { logoLoopRef.current?.revert() } catch { /* ignore */ }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Once ready, request the explosion. It waits for the decrypt to finish and
  // for the loading bounce to have shown for BOOT_LOADING_MIN; the decrypt's
  // onComplete covers the case where ready arrived mid-decrypt.
  useEffect(() => {
    if (ready) requestExplode()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready])

  if (!mounted) return null
  return (
    <div id="tc-boot-overlay" ref={overlayRef}>
      <div className="tc-boot-brand">
        {/* Polymarket mark above the wordmark (shatters from its own centre) */}
        <div className="tc-boot-logo-wrap">
          <svg ref={polySvgRef} className="tc-boot-poly" viewBox="0 0 512 512" width="84" height="84" aria-hidden="true">
            <path d={POLY_PATH} />
          </svg>
          <div className="tc-boot-shards" ref={shardRef} aria-hidden="true" />
        </div>
        <span className="tc-boot-word" ref={wordRef} aria-label={BOOT_WORD}>{BOOT_WORD}</span>
        <div className="tc-boot-particles" ref={particleRef} aria-hidden="true" />
      </div>
    </div>
  )
}

// ── Connection-lost banner ────────────────────────────────────────────────────
function ConnBanner() {
  return (
    <div className="tc-conn-banner">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
      {STR.SSE_DOWN}
    </div>
  )
}

// ── Feed-degraded banner ──────────────────────────────────────────────────────
function FeedBanner() {
  return (
    <div className="tc-feed-banner">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M4.9 19.1C1 15.2 1 8.8 4.9 4.9"/><path d="M7.8 16.2c-2.3-2.3-2.3-6.1 0-8.5"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8c2.3 2.3 2.3 6.1 0 8.5"/><path d="M19.1 4.9C23 8.8 23 15.2 19.1 19.1"/></svg>
      {STR.FEED_DEGRADED}
    </div>
  )
}

// ── Viewport: mobile vs desktop ─────────────────────────────────────────────
// Drives the top-level layout swap. Reactive to resize/orientation so toggling
// device emulation or rotating the phone re-renders the right surface.
function useIsMobile(): boolean {
  const [mobile, setMobile] = useState(
    typeof window !== 'undefined' && window.matchMedia(`(max-width: ${BP.TABLET}px)`).matches
  )
  useEffect(() => {
    const mq = window.matchMedia(`(max-width: ${BP.TABLET}px)`)
    const on = () => setMobile(mq.matches)
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [])
  return mobile
}

// ── Main App ──────────────────────────────────────────────────────────────────
export function App() {
  const feedDegraded = useStore((s) => s.feed_degraded)
  const showWallet = useStore((s) => s.show_wallet)
  const practice = useStore((s) => s.practice)
  useFpsReporter()

  // Apply theme from store
  const theme = useStore((s) => s.theme)
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme === 'light' ? 'light' : 'dark')
  }, [theme])

  // Silently re-attach to an already-authorized browser wallet on load, so the
  // connection survives a refresh (no Connect click). eth_accounts → no popup.
  useEffect(() => {
    let cancelled = false
    const attempt = async () => {
      if (cancelled || useStore.getState().mm_address) return
      const res = await tryReconnect()
      if (res?.ok && !cancelled) {
        useStore.getState()._patch({ mm_address: res.address, mm_status: '' })
        call('on_mm_connect', res.address, '0x89', true) // silent — no "connected" toast on reload
        await refreshBrowserPortfolio(res.address)
      }
    }
    attempt()
    const t = setTimeout(attempt, 800) // EIP-6963 providers may announce just after load
    return () => { cancelled = true; clearTimeout(t) }
  }, [])

  // Keep the connected wallet's balances/positions fresh app-wide (the top bar
  // reads these) — not just while the wallet panel is open.
  const mmAddr = useStore((s) => s.mm_address)
  const browserMode = useStore((s) => s.sign_mode) === 'wallet'
  useEffect(() => {
    if (!browserMode || !mmAddr) return
    refreshBrowserPortfolio(mmAddr)
    const id = setInterval(() => refreshBrowserPortfolio(mmAddr), 15000)
    return () => clearInterval(id)
  }, [browserMode, mmAddr])

  // App is revealed only once everything is loaded AND functioning.
  const ready = useAppReady()
  // unveiling flips at the moment of the boot explosion — the app unblurs and
  // its columns animate in together with the burst, not when `ready` first goes
  // true (which can be mid-decrypt, behind the still-opaque overlay).
  const [unveiling, setUnveiling] = useState(false)

  const isMobile = useIsMobile()

  return (
    <>
      {/* ── Sitewide toast notifications ── */}
      <Toasts />


      {/* ── Boot overlay (held until ready, then explodes + unblurs the app) ── */}
      <BootOverlay ready={ready} onUnveil={() => setUnveiling(true)} />

      {/* ── Mobile: a fully separate single-column surface (≤768px) ── */}
      {isMobile && <MobileApp unveiling={unveiling} />}

      {/* ── Desktop: the three-column layout (unchanged) ── */}
      {!isMobile && (
      <div
        id="tc-app-root"
        className={unveiling ? undefined : 'tc-boot-blur'}
        style={{
          background: 'var(--tc-bg)',
          padding: D.GAP_MD,
          height: '100vh',
          width: '100%',
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          boxSizing: 'border-box',
          gap: D.GAP_MD,
        }}
      >
        {/* ── Top nav bar ── */}
        <div
          className={unveiling ? 'tc-reveal-nav' : undefined}
          style={{ width: '100%', flexShrink: 0, height: 'var(--tc-topbar-h)' }}
        >
          <Nav />
        </div>

        {/* ── Feed-degraded banner ── */}
        {feedDegraded && <FeedBanner />}

        {/* ── Main content row ── */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            flex: 1,
            minHeight: 0,
            overflow: 'visible',
            width: '100%',
            gap: D.GAP_MD,
          }}
        >
          {/* LEFT column: reorderable / resizable dock (time · markets · stats · logs) */}
          <div
            className={`${unveiling ? 'tc-reveal-1 ' : ''}tc-left-col`}
            style={{
              width: 'var(--tc-left-w)',
              flexShrink: 0,
              height: '100%',
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            <LeftDock />
          </div>

          {/* CENTER: Chart */}
          <div
            data-spot="chart"
            className={unveiling ? 'tc-reveal-2' : undefined}
            style={{
              flex: 1,
              minWidth: 0,
              display: 'flex',
              flexDirection: 'column',
              border: '1px solid var(--tc-border)',
              borderRadius: D.R_CARD,
              overflow: 'hidden',
              background: 'var(--tc-card)',
              boxShadow: 'var(--tc-elev-2)',
            }}
          >
            <ChartView />
          </div>

          {/* RIGHT column: trading/wallet + market panel */}
          <div
            className={`${unveiling ? 'tc-reveal-3 ' : ''}tc-right-col`}
            style={{
              width: 'var(--tc-right-w)',
              flexShrink: 0,
              height: '100%',
              minHeight: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: D.GAP_MD,
            }}
          >
            {/* Trading box or Wallet panel */}
            <div
              data-spot="trading"
              style={{
                width: '100%',
                flexShrink: 0,
                overflow: 'hidden',
                border: '1px solid var(--tc-border)',
                borderRadius: D.R_CARD,
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {showWallet && !practice ? <WalletPanel /> : <TradingBar />}
            </div>

            {/* Market/social panel */}
            <div
              data-spot="social"
              style={{
                width: '100%',
                flex: 1,
                minHeight: 0,
                display: 'flex',
                flexDirection: 'column',
                borderRadius: D.R_CARD,
                overflow: 'hidden',
              }}
            >
              <MarketPanel />
            </div>
          </div>
        </div>
      </div>
      )}
    </>
  )
}
