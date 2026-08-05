/**
 * Slot-machine / odometer digit roll for time displays.
 *
 * Each digit is a vertical 0–9 strip clipped to a 1em window; changing the
 * value slides the strip with a spring ease, so the timer "rolls" like a
 * casino reel. All sizing is in `em`, so it scales with the parent font-size.
 */
import type { CSSProperties } from 'react'

function RollDigit({ n }: { n: number }): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-block',
        height: '1em',
        lineHeight: '1em',
        overflow: 'hidden',
        verticalAlign: 'bottom',
      }}
    >
      <span
        style={{
          display: 'flex',
          flexDirection: 'column',
          transform: `translateY(${-n}em)`,
          transition: 'transform 0.6s cubic-bezier(0.16, 1, 0.3, 1)',
          willChange: 'transform',
        }}
      >
        {Array.from({ length: 10 }, (_, i) => (
          <span key={i} style={{ height: '1em', lineHeight: '1em' }}>
            {i}
          </span>
        ))}
      </span>
    </span>
  )
}

export function RollDigits(
  { text, style, className }: { text: string; style?: CSSProperties; className?: string },
): JSX.Element {
  return (
    <span className={className} style={{ display: 'inline-flex', alignItems: 'flex-end', ...style }}>
      {text.split('').map((ch, i) =>
        /\d/.test(ch) ? (
          <RollDigit key={i} n={parseInt(ch, 10)} />
        ) : (
          <span key={i} style={{ display: 'inline-block', height: '1em', lineHeight: '1em' }}>
            {ch}
          </span>
        ),
      )}
    </span>
  )
}
