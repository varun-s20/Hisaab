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
    //
    // `document.hidden` belongs in the same test. A browser does not run
    // requestAnimationFrame in a tab nobody is looking at, so a figure that
    // changed while the app was in the background never reached its target —
    // the headline read ₹250 with ₹349 in the line beneath it, both computed
    // from the same rows. A number is not worth animating to a screen that is
    // not on; it is worth being correct on.
    if (reduced || start === target || document.hidden) return setShown(target)

    const t0 = performance.now()
    const tick = (now) => {
      const p = Math.min(1, (now - t0) / DURATION)
      setShown(start + (target - start) * easeOut(p))
      if (p < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    // Whatever the animation had reached, the figure is the figure. Cancelling
    // without this leaves whichever frame happened to be last on screen.
    return () => {
      cancelAnimationFrame(raf.current)
      setShown(target)
    }
  }, [value])

  return (
    <span className={`num ${className}`.trim()}>
      <span className="rupee">₹</span>
      {money(shown)}
    </span>
  )
}
