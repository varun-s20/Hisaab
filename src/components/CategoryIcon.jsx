import { colorFor } from '../lib/categories'

// Fourteen glyphs, one per category. Stroke-based on a 24 grid so they hold up
// at 16px and inherit the category colour. Inline because a whole icon package
// for fourteen shapes is 40kB to avoid writing 40 lines.

const PATHS = {
  'Food & Dining': (
    <>
      <path d="M6 3v5a2.6 2.6 0 0 0 5.2 0V3" />
      <path d="M8.6 10.6V21" />
      <path d="M17.6 3c-1.7 1.7-1.7 6.6 0 8.3V21" />
    </>
  ),
  Groceries: (
    <>
      <path d="M5.2 8h13.6l-1.1 11.1A2 2 0 0 1 15.7 21H8.3a2 2 0 0 1-2-1.9L5.2 8Z" />
      <path d="M9 8V6.2a3 3 0 0 1 6 0V8" />
    </>
  ),
  Transport: (
    <>
      <path d="M5.2 11.2 6.7 7a2 2 0 0 1 1.9-1.3h6.8A2 2 0 0 1 17.3 7l1.5 4.2" />
      <path d="M4.2 11.2h15.6a1 1 0 0 1 1 1v4.3H3.2v-4.3a1 1 0 0 1 1-1Z" />
      <circle cx="7.2" cy="18.4" r="1.7" />
      <circle cx="16.8" cy="18.4" r="1.7" />
    </>
  ),
  Shopping: (
    <>
      <path d="M20.4 12.6 12.6 20.4a2 2 0 0 1-2.8 0L3.6 14.2a2 2 0 0 1-.6-1.4V4.4a1.4 1.4 0 0 1 1.4-1.4h8.4a2 2 0 0 1 1.4.6l6.2 6.2a2 2 0 0 1 0 2.8Z" />
      <circle cx="7.6" cy="7.6" r="1.3" />
    </>
  ),
  'Bills & Utilities': <path d="M13.2 2.5 4.6 14h6.6l-1 7.5L18.8 10h-6.6l1-7.5Z" />,
  Rent: (
    <>
      <path d="M3 10.4 12 3.2l9 7.2" />
      <path d="M5.2 9.2V20a1 1 0 0 0 1 1h11.6a1 1 0 0 0 1-1V9.2" />
      <path d="M9.6 21v-5.6h4.8V21" />
    </>
  ),
  Health: (
    <path d="M20.6 8.4A4.9 4.9 0 0 0 12 5.3a4.9 4.9 0 0 0-8.6 3.1c0 5.3 8.6 11.2 8.6 11.2s8.6-5.9 8.6-11.2Z" />
  ),
  Entertainment: (
    <>
      <circle cx="12" cy="12" r="8.8" />
      <path d="M10.2 8.4 16 12l-5.8 3.6V8.4Z" />
    </>
  ),
  Education: (
    <>
      <path d="M2.6 8.6 12 4.2l9.4 4.4-9.4 4.4-9.4-4.4Z" />
      <path d="M6.4 10.6v5c0 1.5 2.5 2.8 5.6 2.8s5.6-1.3 5.6-2.8v-5" />
    </>
  ),
  'Personal Care': <path d="M12 3.2s5.9 6.2 5.9 9.9a5.9 5.9 0 0 1-11.8 0c0-3.7 5.9-9.9 5.9-9.9Z" />,
  'Household Help': (
    <>
      <path d="M11 3.2 12.5 7.4 16.7 9l-4.2 1.6L11 14.8 9.4 10.6 5.2 9l4.2-1.6L11 3.2Z" />
      <path d="M18 14.4 18.8 16.6 21 17.4l-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2Z" />
    </>
  ),
  Transfers: (
    <>
      <path d="M4 8.4h13" />
      <path d="M14 5.4 17 8.4 14 11.4" />
      <path d="M20 15.6H7" />
      <path d="M10 12.6 7 15.6 10 18.6" />
    </>
  ),
  Income: (
    <>
      <path d="M12 3.4v10.8" />
      <path d="M8 10.4 12 14.4 16 10.4" />
      <path d="M4.2 16.6v2.2a2 2 0 0 0 2 2h11.6a2 2 0 0 0 2-2v-2.2" />
    </>
  ),
  Other: (
    <>
      <circle cx="12" cy="12" r="8.8" />
      <circle cx="8.4" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="15.6" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
}

/** The glyph alone, taking its colour from the parent. */
export function Glyph({ category }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[category] ?? PATHS.Other}
    </svg>
  )
}

/** Rounded tile, built the way Wise builds their colour cards: the bright
 *  pastel carries the panel, forest green carries the content. Because the
 *  glyph colour never changes, contrast holds on white and on #121511 alike —
 *  a pastel-on-pastel tile would have vanished on the light theme. */
export default function CategoryIcon({ category, className = 'tile' }) {
  return (
    <span className={className} style={{ background: colorFor(category), color: '#163300' }}>
      <Glyph category={category} />
    </span>
  )
}
