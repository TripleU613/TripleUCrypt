/**
 * OnboardBrowser — a real browser, running on the server, embedded in the wallet tab.
 *
 * A headless Chromium runs server-side and its screen streams here as JPEG frames over
 * a WebSocket; taps and typing go back the other way. Polymarket (and anything else)
 * sees the SERVER's IP, not the user's — the whole point.
 *
 * It is a GENERAL-PURPOSE browser, not a kiosk: address bar, back/forward/reload, and
 * no allowlist. Whatever a user needs to reach to get set up — a wallet, an exchange,
 * their email, a support page — they can reach, without us guessing the list up front.
 *
 * Typing goes to the PAGE by default (a hidden input focused on tap, which also raises
 * the mobile keyboard). The address bar is a separate, explicit field so page typing and
 * URL typing never fight over the same keystrokes.
 */

import React, { useEffect, useRef, useState } from 'react'
import { C, D, SP, FS, FW, FONT } from '../../constants/index.js'

type Incoming =
  | { t: 'frame'; data: string; w: number; h: number }
  | { t: 'url'; url: string; loading: boolean }
  | { t: 'error'; message: string }

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/onboard/ws`
}

// Compact chrome button (back / forward / reload).
function ChromeBtn({ label, title, onClick }: { label: string; title: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      title={title}
      aria-label={title}
      style={{
        flexShrink: 0, width: '30px', height: '30px', borderRadius: D.R_SM,
        border: '1px solid var(--tc-border)', background: 'var(--tc-card-alt)',
        color: 'var(--tc-dim2)', fontSize: FS.XS, fontFamily: FONT.MONO,
        cursor: 'pointer', lineHeight: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >{label}</button>
  )
}

export function OnboardBrowser() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const kbdRef = useRef<HTMLInputElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const dims = useRef({ w: 390, h: 780 })
  const [err, setErr] = useState('')
  const [addr, setAddr] = useState('')          // what the address bar shows
  const [editing, setEditing] = useState(false) // don't fight the user while they type
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const ws = new WebSocket(wsUrl())
    wsRef.current = ws
    const img = new Image()
    let pending: string | null = null
    let drawing = false

    const pump = () => {
      if (drawing || !pending) return
      drawing = true
      img.src = 'data:image/jpeg;base64,' + pending
      pending = null
    }
    img.onload = () => {
      const cv = canvasRef.current
      if (cv) {
        if (cv.width !== img.width || cv.height !== img.height) { cv.width = img.width; cv.height = img.height }
        cv.getContext('2d')?.drawImage(img, 0, 0)
      }
      drawing = false
      pump()
    }

    ws.onmessage = (e: MessageEvent) => {
      let msg: Incoming
      try { msg = JSON.parse(e.data) } catch { return }
      if (msg.t === 'frame') { dims.current = { w: msg.w, h: msg.h }; pending = msg.data; pump() }
      else if (msg.t === 'url') {
        setLoading(msg.loading)
        // Never overwrite what the user is mid-way through typing.
        setEditing(cur => { if (!cur) setAddr(msg.url === 'about:blank' ? '' : msg.url); return cur })
      }
      else if (msg.t === 'error') setErr(msg.message)
    }
    ws.onerror = () => setErr('lost connection to the browser')
    ws.onclose = () => { if (wsRef.current === ws) setErr('lost connection to the browser') }

    return () => { try { ws.close() } catch { /* */ } wsRef.current = null }
  }, [])

  const send = (obj: unknown): void => {
    const ws = wsRef.current
    if (ws && ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(obj)) } catch { /* */ } }
  }

  const toPage = (clientX: number, clientY: number): { x: number; y: number } => {
    const cv = canvasRef.current
    if (!cv) return { x: 0, y: 0 }
    const r = cv.getBoundingClientRect()
    const fx = (clientX - r.left) / Math.max(r.width, 1)
    const fy = (clientY - r.top) / Math.max(r.height, 1)
    return {
      x: Math.max(0, Math.min(dims.current.w, fx * dims.current.w)),
      y: Math.max(0, Math.min(dims.current.h, fy * dims.current.h)),
    }
  }

  const onPointer = (type: 'move' | 'down' | 'up') => (e: React.PointerEvent) => {
    const { x, y } = toPage(e.clientX, e.clientY)
    send({ t: 'input', ev: { type, x, y } })
    // Tapping the page hands typing back to the page (and raises the mobile keyboard).
    if (type === 'up') { setEditing(false); kbdRef.current?.focus() }
  }
  const onKbd = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Tab' || e.key.startsWith('Arrow')) {
      e.preventDefault(); send({ t: 'input', ev: { type: 'key', key: e.key } })
    }
  }
  const onKbdInput = (e: React.FormEvent<HTMLInputElement>) => {
    const el = e.currentTarget
    if (el.value) { send({ t: 'input', ev: { type: 'key', text: el.value } }); el.value = '' }
  }

  const go = () => { setEditing(false); setLoading(true); send({ t: 'nav', url: addr }) }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP.XS, width: '100%', height: '100%' }}>
      {/* Browser chrome: history, reload, address/search bar. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: SP.XS, width: '100%' }}>
        <ChromeBtn label="‹" title="Back" onClick={() => send({ t: 'back' })} />
        <ChromeBtn label="›" title="Forward" onClick={() => send({ t: 'forward' })} />
        <ChromeBtn label={loading ? '×' : '⟳'} title={loading ? 'Loading' : 'Reload'} onClick={() => send({ t: 'reload' })} />
        <input
          value={addr}
          onChange={e => { setAddr(e.target.value); setEditing(true) }}
          onFocus={() => setEditing(true)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); go() } }}
          placeholder="Search or enter address"
          spellCheck={false} autoComplete="off" autoCapitalize="off" autoCorrect="off"
          inputMode="url"
          style={{
            flex: 1, minWidth: 0, padding: `${SP.XS} ${SP.MD}`, borderRadius: D.R_BTN,
            border: '1px solid var(--tc-border)', background: 'var(--tc-card-alt)',
            color: 'var(--tc-text-strong)', fontSize: FS.XS, fontFamily: FONT.MONO, outline: 'none',
          }}
        />
        <button
          onClick={go}
          title="Go"
          style={{
            flexShrink: 0, padding: `${SP.XS} ${SP.MD}`, height: '30px', borderRadius: D.R_BTN,
            border: `1px solid ${C.GREEN_BORDER}`, background: 'transparent', color: C.GREEN,
            fontSize: FS.NANO, fontWeight: FW.XBOLD, fontFamily: FONT.MONO, cursor: 'pointer',
          }}
        >GO</button>
      </div>

      <div style={{
        position: 'relative', flex: 1, minHeight: 0, width: '100%',
        background: '#000', borderRadius: D.R_CARD, overflow: 'hidden', border: '1px solid var(--tc-border)',
        display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
      }}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointer('down')}
          onPointerMove={onPointer('move')}
          onPointerUp={onPointer('up')}
          style={{ height: '100%', width: 'auto', maxWidth: '100%', display: 'block', touchAction: 'none' }}
        />
        {/* Invisible page-keyboard capture; pointer-events:none so it never eats taps. */}
        <input
          ref={kbdRef}
          onKeyDown={onKbd}
          onInput={onKbdInput}
          autoCapitalize="off" autoCorrect="off" spellCheck={false} aria-hidden
          style={{ position: 'absolute', bottom: 0, left: 0, width: 1, height: 1, opacity: 0, pointerEvents: 'none', border: 0, padding: 0 }}
        />
        {err && (
          <div style={{
            position: 'absolute', bottom: SP.MD, left: SP.MD, right: SP.MD,
            padding: `${SP.SM} ${SP.MD}`, borderRadius: D.R_BTN,
            background: 'rgba(0,0,0,0.8)', border: `1px solid ${C.RED}`,
            color: C.RED, fontSize: FS.NANO, fontFamily: FONT.MONO, textAlign: 'center',
          }}>{err}</div>
        )}
      </div>
    </div>
  )
}
