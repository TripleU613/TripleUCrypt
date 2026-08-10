/**
 * Theme styles now live in client/theme.css (a real stylesheet emitted by Vite),
 * so they can paint before/alongside the JS bundle rather than after it.
 *
 * injectTheme() is kept as a no-op purely so nothing has to change at the call
 * site; the <link> Vite injects does the work. Safe to delete along with its one
 * caller in main.tsx.
 */
export function injectTheme(): void {
  /* no-op: styles ship as a stylesheet, see client/theme.css */
}
