/**
 * OnboardBrowser — the embedded Polymarket browser, rendered inside the wallet tab.
 *
 * A real browser runs on the server (so Polymarket sees the server's IP), and its
 * screen streams here as JPEG frames over a WebSocket; taps and typing go back.
 * The site cannot be iframed, but its pixels can be drawn to a <canvas>.
 *
 * Chrome-free by design: no title bar, no status pills, no visible keyboard field.
 * Just the page. Typing works because tapping the canvas focuses a hidden input
 * (which also pops the on-screen keyboard on mobile). The parent owns show/hide.
 *
 * Reads only PUBLIC page data (the on-chain proxy address). Never private keys or
 * seed phrases — with WalletConnect the key is on the user's phone and cannot reach
 * here anyway, and there is no code path that would try.
 */

import React, { useEffect, useRef, useState } from 'react'
import { C, D, SP, FS, FONT } from '../../constants/index.js'

type Frame = { t: 'frame'; data: string; w: number; h: number }
type ErrMsg = { t: 'error'; message: string }
type Incoming = Frame | ErrMsg

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/onboard/ws`
}

export function OnboardBrowser() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const kbdRef = useRef<HTMLInputElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const dims = useRef({ w: 390, h: 780 })
  const [err, setErr] = useState('')       // only surfaced on failure; success is silent

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
      else if (msg.t === 'error') setErr(msg.message)
    }
    ws.onerror = () => setErr('lost connection to the browser')
    ws.onclose = () => { if (wsRef.current === ws) setErr('lost connection to the browser') }

    return () => { try { ws.close() } catch { /* */ } wsRef.current = null }
  }, [])

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
  const send = (obj: unknown): void => {
    const ws = wsRef.current
    if (ws && ws.readyState === ws.OPEN) { try { ws.send(JSON.stringify(obj)) } catch { /* */ } }
  }
  const onPointer = (type: 'move' | 'down' | 'up') => (e: React.PointerEvent) => {
    const { x, y } = toPage(e.clientX, e.clientY)
    send({ t: 'input', ev: { type, x, y } })
    if (type === 'up') kbdRef.current?.focus()   // pop the keyboard for whatever field was tapped
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

  return (
    <div style={{
      position: 'relative', width: '100%', height: '100%',
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
      {/* Invisible keyboard capture — focused on tap so the on-screen keyboard opens.
          pointer-events:none so it never blocks canvas gestures. */}
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
  )
}
