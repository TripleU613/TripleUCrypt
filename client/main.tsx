import React from 'react'
import ReactDOM from 'react-dom/client'
import { injectTheme } from './theme.js'
injectTheme()
import { App } from './App.js'
import { connectSSE } from './sse-client.js'

// Apply saved theme before first render (avoids flash)
try {
  const raw = localStorage.getItem('tc_theme')
  let t = 'dark'
  if (raw) {
    try { t = JSON.parse(raw) } catch { t = raw }
    if (typeof t === 'string') t = t.replace(/^"+|"+$/g, '')
  }
  if (t !== 'light' && t !== 'dark') t = 'dark'
  document.documentElement.setAttribute('data-theme', t)
} catch {
  document.documentElement.setAttribute('data-theme', 'dark')
}

// Start SSE connection
connectSSE()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
