/**
 * Sitewide toast notifications.
 *
 * Any engine/server module can call `notify(text, level)` to float a bubble
 * up on every connected client:
 *   - 'log'   → green  (success / info)
 *   - 'warn'  → orange (warning / something off)
 *   - 'error' → red    (failure / error)
 *
 * Notifications are pushed as a dedicated SSE event (see src/server/sse.ts),
 * NOT stored in AppState — they're ephemeral UI, owned + auto-dismissed by the
 * client.
 */
import { bus } from '../bus.js'

export type NotifyLevel = 'log' | 'warn' | 'error'

let _nid = 0

/** Push a sitewide toast notification to every connected client. */
export function notify(text: string, level: NotifyLevel = 'log'): void {
  const msg = (text ?? '').trim()
  if (!msg) return
  bus.emit('notify', { id: ++_nid, level, text: msg })
}
