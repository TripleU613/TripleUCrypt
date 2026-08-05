/**
 * kickBuses — force every live market socket to attempt recovery NOW.
 *
 * Each bus already has its own zombie watchdog, but those run on
 * `setInterval`, which the browser throttles to roughly once a minute in a
 * hidden tab and stops entirely once the tab is frozen. So after returning to
 * a tab that sat in the background, recovery could otherwise wait on a timer
 * that hasn't fired plus a backoff that has grown.
 *
 * Called from client/sse-client.ts on visibilitychange / online / pageshow, and
 * whenever the SSE watchdog finds a dead stream (the same network event usually
 * killed the sockets too).
 *
 * Kept in its own module so sse-client.ts does not import the bus singletons
 * for their side effects.
 */

import { kick as kickRtds } from './RtdsBus.js'
import { kick as kickClob } from './ClobBus.js'

export function kickBuses(): void {
  // Never let one bus's failure stop the other from recovering.
  try { kickRtds() } catch { /* ignore */ }
  try { kickClob() } catch { /* ignore */ }
}
