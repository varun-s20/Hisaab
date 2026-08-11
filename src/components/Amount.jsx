import { useEffect, useRef, useState } from 'react'
import { money } from '../lib/format'

// The one counting number in the app, on the two cards that carry the headline
// figure. Emil's frequency rule: a screen you open once a day earns a moment;
// a row you scroll past forty times a day does not — so this is deliberately
// not used in the ledger.

const easeOut = (t) => 1 - Math.pow(1 - t, 3)
const DURATION = 520

export default function Amount({ value, className = '' }) {
  // Both start at zero so the first paint counts up rather than snapping.
  const [shown, setShown] = useState(0)
  const from = useRef(0)
  const raf = useRef(0)

  useEffect(() => {
    const target = Number(value) || 0
    const start = Number(from.current) || 0
    from.current = target

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
    // Counting up from zero on first paint is the point; counting between two
    // unrelated figures on a refetch is noise. Only animate a real change.
    if (reduced || start === target) return setShown(target)

    const t0 = performance.now()
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / DURATION)
      setShown(start + (target - start) * easeOut(p))
      if (p < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [value])

  return (
    <span className={`num ${className}`.trim()}>
      <span className="rupee">₹</span>
      {money(shown)}
    </span>
  )
}
