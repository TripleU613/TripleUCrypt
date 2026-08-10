/**
 * OnboardBrowser — the embedded Polymarket browser, rendered inside the wallet tab.
 *
 * This is the point of the whole subsystem: the user sets up Polymarket HERE, never
 * in a separate tab. A real browser runs on the server (so Polymarket sees the
 * server's IP), and its screen is streamed here as JPEG frames over a WebSocket;
 * taps and typing go back the other way. The site cannot be iframed, but its pixels
 * can be drawn to a <canvas>.
 *
 * Coordinates: frames carry the page's CSS pixel size (w,h, e.g. 390x780). Input
 * events must be in that same CSS space, so pointer positions are mapped from the
 * canvas's on-screen rect back into 0..w / 0..h before sending.
 */

import React, { useEffect, useRef, useState } from 'react'
import { C, D, SP, FS, FW, FONT } from '../../constants/index.js'

type Frame = { t: 'frame'; data: string; w: number; h: number }
type ErrMsg = { t: 'error'; message: string }
type Incoming = Frame | ErrMsg

function wsUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}/onboard/ws`
}

export function OnboardBrowser({ onClose }: { onClose?: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const kbdRef = useRef<HTMLInputElement>(null)
  const wsRef = useRef<WebSocket | null>(null)
  // Live frame dimensions (page CSS px) — the input coordinate space.
  const dims = useRef({ w: 390, h: 780 })
  const [status, setStatus] = useState<'connecting' | 'live' | 'error'>('connecting')
  const [err, setErr] = useState('')

  useEffect(() => {
    const ws = new WebSocket(wsUrl())
    wsRef.current = ws
    const img = new Image()
    let pending: string | null = null
    let drawing = false

    // Decode the latest frame only; if frames arrive faster than we draw, drop the
    // stale ones rather than queue (keeps latency flat).
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

    ws.onopen = () => setStatus('live')
    ws.onmessage = (e: MessageEvent) => {
      let msg: Incoming
      try { msg = JSON.parse(e.data) } catch { return }
      if (msg.t === 'frame') {
        dims.current = { w: msg.w, h: msg.h }
        pending = msg.data
        pump()
      } else if (msg.t === 'error') {
        setErr(msg.message); setStatus('error')
      }
    }
    ws.onerror = () => { setStatus('error'); setErr('connection failed') }
    ws.onclose = () => { if (wsRef.current === ws) setStatus('error') }

    return () => { try { ws.close() } catch { /* */ } wsRef.current = null }
  }, [])

  // Map an on-screen pointer to page CSS coordinates.
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
    // Tapping the page should surface the on-screen keyboard so the user can type
    // into whatever Polymarket field they touched (email, code, amount).
    if (type === 'up') kbdRef.current?.focus()
  }

  // Keystroke forwarder. The hidden input captures the mobile/desktop keyboard;
  // printable text goes as insertText, named keys (Enter, Backspace) as key events.
  const onKbd = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === 'Backspace' || e.key === 'Tab' || e.key.startsWith('Arrow')) {
      e.preventDefault()
      send({ t: 'input', ev: { type: 'key', key: e.key } })
    }
  }
  const onKbdInput = (e: React.FormEvent<HTMLInputElement>) => {
    const el = e.currentTarget
    if (el.value) { send({ t: 'input', ev: { type: 'key', text: el.value } }); el.value = '' }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP.SM, width: '100%', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: SP.SM }}>
        <span style={{ fontSize: FS.XS, fontWeight: FW.XBOLD, fontFamily: FONT.MONO, color: 'var(--tc-dim2)', flex: 1 }}>
          POLYMARKET — set up here, no separate tab
        </span>
        <span style={{ fontSize: FS.NANO, fontFamily: FONT.MONO,
                       color: status === 'live' ? C.GREEN : status === 'error' ? C.RED : C.GOLD }}>
          {status === 'live' ? '● live' : status === 'error' ? '● ' + (err || 'error') : '○ connecting…'}
        </span>
        {onClose && (
          <button onClick={onClose} style={{
            border: '1px solid var(--tc-border)', background: 'transparent', color: 'var(--tc-dim2)',
            borderRadius: D.R_SM, fontSize: FS.NANO, fontFamily: FONT.MONO, cursor: 'pointer', padding: `${SP.XXS} ${SP.SM}`,
          }}>close</button>
        )}
      </div>

      <div style={{
        position: 'relative', flex: 1, minHeight: 0, width: '100%',
        display: 'flex', justifyContent: 'center', alignItems: 'flex-start',
        background: '#000', borderRadius: D.R_CARD, overflow: 'hidden', border: '1px solid var(--tc-border)',
      }}>
        <canvas
          ref={canvasRef}
          onPointerDown={onPointer('down')}
          onPointerMove={onPointer('move')}
          onPointerUp={onPointer('up')}
          style={{
            height: '100%', width: 'auto', maxWidth: '100%', display: 'block',
            touchAction: 'none',      // we own the gesture; don't scroll the page
            objectFit: 'contain',
          }}
        />
      </div>

      {/* Keystroke capture. Kept visible + labelled so it's obvious where to type on
          desktop; on mobile it also pops the on-screen keyboard when a field is tapped. */}
      <input
        ref={kbdRef}
        onKeyDown={onKbd}
        onInput={onKbdInput}
        placeholder="type / paste here → goes to the page above"
        autoCapitalize="off" autoCorrect="off" spellCheck={false}
        style={{
          width: '100%', padding: `${SP.SM} ${SP.MD}`, borderRadius: D.R_BTN,
          border: '1px solid var(--tc-border)', background: 'var(--tc-card-alt)',
          color: 'var(--tc-text-strong)', fontSize: FS.XS, fontFamily: FONT.MONO, outline: 'none',
        }}
      />
    </div>
  )
}
