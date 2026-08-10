/**
 * OnboardBrowser — a real Chromium window, running on the server, inside the wallet tab.
 *
 * This renders the ACTUAL browser: its own toolbar, tabs, omnibox, back/forward, menus
 * and extension buttons. Nothing here draws browser UI — what you see is Chromium.
 *
 * How: Chromium runs headed on a virtual X display on the server, x11vnc exports that
 * display, and noVNC draws it here over a WebSocket. (The earlier version streamed via
 * CDP screencast, which captures only the page viewport — browser chrome is never in
 * those frames, so the toolbar had to be faked in React. This replaces that.)
 *
 * Mobile mode: the display is phone-shaped and portrait with a mobile user-agent, so
 * sites serve their mobile layout and the window fits the wallet tab.
 *
 * Everything the user types goes to Chromium. This component reads nothing from the
 * session — it is a screen and a mouse, not a wallet.
 */

import React, { useEffect, useRef, useState } from 'react'
import { C, D, SP, FS, FONT } from '../../constants/index.js'

function vncUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/onboard/vnc`
}

export function OnboardBrowser() {
  const holderRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'connecting' | 'live' | 'error'>('connecting')
  const [err, setErr] = useState('')

  useEffect(() => {
    let rfb: { disconnect(): void; addEventListener(t: string, f: () => void): void;
               scaleViewport: boolean; resizeSession: boolean; focusOnClick: boolean } | null = null
    let cancelled = false

    // noVNC is bundled (a dependency, not a CDN script) so the artifact CSP is satisfied
    // and there is no third-party request. Loaded lazily: it is only needed when someone
    // actually opens the browser, and it should not sit in the entry bundle.
    void import('@novnc/novnc/lib/rfb.js').then(mod => {
      if (cancelled || !holderRef.current) return
      const RFB = mod.default
      try {
        const r = new RFB(holderRef.current, vncUrl(), {}) as unknown as typeof rfb
        rfb = r
        if (r) {
          // Fit the real window into whatever space the wallet tab gives us, without
          // asking the server to resize its display (the phone shape is deliberate).
          r.scaleViewport = true
          r.resizeSession = false
          r.focusOnClick = true
          r.addEventListener('connect', () => setStatus('live'))
          r.addEventListener('disconnect', () => {
            setStatus('error'); setErr('browser session ended')
          })
          r.addEventListener('securityfailure', () => {
            setStatus('error'); setErr('could not authenticate to the browser')
          })
        }
      } catch (e) {
        setStatus('error'); setErr(String(e instanceof Error ? e.message : e))
      }
    }).catch(e => {
      setStatus('error'); setErr('viewer failed to load: ' + String(e instanceof Error ? e.message : e))
    })

    return () => {
      cancelled = true
      try { rfb?.disconnect() } catch { /* */ }
    }
  }, [])

  return (
    <div style={{
      position: 'relative', width: '100%', height: '100%',
      background: '#000', borderRadius: D.R_CARD, overflow: 'hidden',
      border: '1px solid var(--tc-border)',
    }}>
      {/* noVNC attaches its own canvas in here and handles mouse + keyboard itself. */}
      <div ref={holderRef} style={{ width: '100%', height: '100%' }} />

      {status !== 'live' && (
        <div style={{
          position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'rgba(0,0,0,0.75)', padding: SP.LG, textAlign: 'center',
          fontSize: FS.NANO, fontFamily: FONT.MONO, lineHeight: 1.5,
          color: status === 'error' ? C.RED : 'var(--tc-dim2)',
        }}>
          {status === 'error'
            ? (err || 'browser unavailable')
            : 'starting browser on the server…'}
        </div>
      )}
    </div>
  )
}
