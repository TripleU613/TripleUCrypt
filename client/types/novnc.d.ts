/**
 * Minimal typings for @novnc/novnc, which ships none.
 *
 * v1.5.0 ships a Babel CJS build under lib/, with the RFB class as its default export
 * (interop handled by the bundler). Pinned to 1.5.0 because 1.7 uses top-level await,
 * which the app's browser target rejects. Only the members this app touches are declared.
 */
declare module '@novnc/novnc/lib/rfb.js' {
  export interface RFBOptions {
    credentials?: { username?: string; password?: string; target?: string }
    shared?: boolean
    repeaterID?: string
    wsProtocols?: string[]
  }
  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RFBOptions)
    /** Scale the remote framebuffer to fit the container. */
    scaleViewport: boolean
    /** Ask the server to resize its session to match the container (we don't). */
    resizeSession: boolean
    focusOnClick: boolean
    viewOnly: boolean
    disconnect(): void
    focus(): void
    blur(): void
    sendCtrlAltDel(): void
  }
}
