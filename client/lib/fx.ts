/**
 * Subtle hover micro-interactions (anime.js). Call playFx(el, kind) on
 * mouseenter. All one-shot, tiny-amplitude, self-cancelling, and disabled for
 * prefers-reduced-motion. Transform-based effects should target an element
 * that doesn't also carry a CSS hover transform (e.g. an inner span/icon).
 */
import { animate } from 'animejs'

export type FxKind =
  | 'pulse' | 'jiggle' | 'shake' | 'spin' | 'roll'
  | 'bounce' | 'glow' | 'pixelate' | 'flip' | 'pop'

const reduce = (): boolean =>
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

export function playFx(el: Element | null | undefined, kind: FxKind): void {
  if (!el || reduce()) return
  switch (kind) {
    case 'pulse':
      animate(el, { scale: [1, 1.04, 1], duration: 320, ease: 'inOutQuad' }); break
    case 'jiggle':
      // scale bump + rotate wobble — the scale makes it read on round icons
      // where a pure rotation is invisible.
      animate(el, { scale: [1, 1.22, 1], rotate: [0, -10, 8, -4, 0], duration: 520, ease: 'out(2)' }); break
    case 'shake':
      animate(el, { x: [0, -2, 2, -1.5, 0], duration: 360, ease: 'inOutSine' }); break
    case 'spin':
      animate(el, { rotate: [0, 360], duration: 600, ease: 'inOutQuad' }); break
    case 'roll':
      animate(el, { x: [0, 2, 0], rotate: [0, 16, 0], duration: 460, ease: 'inOutSine' }); break
    case 'bounce':
      animate(el, { y: [0, 2, -1, 0], duration: 380, ease: 'out(3)' }); break
    case 'pop':
      animate(el, { scale: [0.96, 1], duration: 260, ease: 'out(3)' }); break
    case 'flip':
      animate(el, { rotateX: [0, 18, 0], duration: 420, ease: 'inOutSine' }); break
    case 'glow':
      animate(el, { filter: ['brightness(1)', 'brightness(1.45)', 'brightness(1)'], duration: 480, ease: 'inOutSine' }); break
    case 'pixelate':
      animate(el, { filter: ['blur(0px)', 'blur(1.1px)', 'blur(0px)'], duration: 200, ease: 'inOutQuad' }); break
  }
}
