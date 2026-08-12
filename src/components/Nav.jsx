import { useEffect, useLayoutEffect, useRef, useState } from 'react'

// The four things at the bottom, and the screens that live behind More. Both
// tables are here because both are about which screen is showing.
export const TABS = [
  ['today', 'Today'],
  ['ledger', 'Ledger'],
  ['insights', 'Insights'],
  ['more', 'More'],
]

export const SUB = ['review', 'teach', 'import', 'ask', 'budgets', 'merchants']

/**
 * The bottom bar.
 *
 * The active pill is one element that moves, not a background that appears on
 * whichever button happens to be current — switching tabs used to be an
 * instant repaint in two places at once, which is the one moment in the app
 * where the motion is the navigation.
 *
 * Measured rather than computed from the index: the buttons are `flex: 1` with
 * a `max-width`, so their width depends on how wide the window is, and a
 * hardcoded `100% / 4` is wrong on every screen except the narrow one.
 */
export default function Nav({ tab, go, badge }) {
  const items = useRef([])
  const [pill, setPill] = useState(null)
  // The first placement must not animate from x=0, so the transition is only
  // switched on once something is already in the right place.
  //
  // State, not a ref: a ref would be set without a re-render, so the attribute
  // in the DOM stayed "false" until something else re-rendered Nav — which is
  // the tab change itself. The transition would then be switched on in the same
  // commit as the first move, and a property that only becomes transitionable
  // at the moment it changes does not animate. The first switch jumped and
  // every one after it slid, which is the sort of bug you spend an evening
  // failing to reproduce.
  const [placed, setPlaced] = useState(false)
  const active = TABS.findIndex(([id]) => id === tab || (id === 'more' && SUB.includes(tab)))

  useLayoutEffect(() => {
    const measure = () => {
      const el = items.current[active]
      if (!el) return
      // Height and top measured too, not hardcoded: the buttons grow when the
      // webfont lands, and a pill pinned to yesterday's line-height sits a
      // pixel proud of the label it is behind.
      setPill({ left: el.offsetLeft, width: el.offsetWidth, top: el.offsetTop, height: el.offsetHeight })
    }
    measure()
    // Font swaps and rotation both change the button widths under it.
    const ro = new ResizeObserver(measure)
    items.current.forEach((el) => el && ro.observe(el))
    return () => ro.disconnect()
  }, [active, badge])

  useEffect(() => {
    if (pill) setPlaced(true)
  }, [pill])

  return (
    <nav className="nav">
      {pill && (
        <span
          className="navpill"
          data-placed={placed}
          aria-hidden="true"
          style={{
            transform: `translateX(${pill.left}px)`,
            width: pill.width,
            top: pill.top,
            height: pill.height,
          }}
        />
      )}
      {TABS.map(([id, label], i) => (
        <button
          key={id}
          ref={(el) => {
            items.current[i] = el
          }}
          aria-current={i === active}
          onClick={() => go(id)}
        >
          {label}
          {/* Both queues, not just review. Teach me was invisible from here,
              so nobody knew it had anything in it. */}
          {id === 'more' && badge > 0 && <span className="badge">{badge}</span>}
        </button>
      ))}
    </nav>
  )
}
