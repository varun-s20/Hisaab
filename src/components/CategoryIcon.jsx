import { colorFor, iconFor } from '../lib/categories'

// Stroke-based glyphs on a 24 grid, so they hold up at 16px and inherit the
// category colour. Inline because a whole icon package for thirty shapes is
// 40kB to avoid writing ninety lines.
//
// Keyed by icon name, not by category name. That is the whole difference: a
// category you invent picks any of these, and every built-in's glyph is in the
// same list — before this, the fourteen defaults were unreachable from the
// "New category" sheet and anything custom got the three-dots fallback.

const ICONS = {
  food: (
    <>
      <path d="M6 3v5a2.6 2.6 0 0 0 5.2 0V3" />
      <path d="M8.6 10.6V21" />
      <path d="M17.6 3c-1.7 1.7-1.7 6.6 0 8.3V21" />
    </>
  ),
  groceries: (
    <>
      <path d="M5.2 8h13.6l-1.1 11.1A2 2 0 0 1 15.7 21H8.3a2 2 0 0 1-2-1.9L5.2 8Z" />
      <path d="M9 8V6.2a3 3 0 0 1 6 0V8" />
    </>
  ),
  transport: (
    <>
      <path d="M5.2 11.2 6.7 7a2 2 0 0 1 1.9-1.3h6.8A2 2 0 0 1 17.3 7l1.5 4.2" />
      <path d="M4.2 11.2h15.6a1 1 0 0 1 1 1v4.3H3.2v-4.3a1 1 0 0 1 1-1Z" />
      <circle cx="7.2" cy="18.4" r="1.7" />
      <circle cx="16.8" cy="18.4" r="1.7" />
    </>
  ),
  shopping: (
    <>
      <path d="M20.4 12.6 12.6 20.4a2 2 0 0 1-2.8 0L3.6 14.2a2 2 0 0 1-.6-1.4V4.4a1.4 1.4 0 0 1 1.4-1.4h8.4a2 2 0 0 1 1.4.6l6.2 6.2a2 2 0 0 1 0 2.8Z" />
      <circle cx="7.6" cy="7.6" r="1.3" />
    </>
  ),
  bills: <path d="M13.2 2.5 4.6 14h6.6l-1 7.5L18.8 10h-6.6l1-7.5Z" />,
  rent: (
    <>
      <path d="M3 10.4 12 3.2l9 7.2" />
      <path d="M5.2 9.2V20a1 1 0 0 0 1 1h11.6a1 1 0 0 0 1-1V9.2" />
      <path d="M9.6 21v-5.6h4.8V21" />
    </>
  ),
  health: (
    <path d="M20.6 8.4A4.9 4.9 0 0 0 12 5.3a4.9 4.9 0 0 0-8.6 3.1c0 5.3 8.6 11.2 8.6 11.2s8.6-5.9 8.6-11.2Z" />
  ),
  entertainment: (
    <>
      <circle cx="12" cy="12" r="8.8" />
      <path d="M10.2 8.4 16 12l-5.8 3.6V8.4Z" />
    </>
  ),
  education: (
    <>
      <path d="M2.6 8.6 12 4.2l9.4 4.4-9.4 4.4-9.4-4.4Z" />
      <path d="M6.4 10.6v5c0 1.5 2.5 2.8 5.6 2.8s5.6-1.3 5.6-2.8v-5" />
    </>
  ),
  'personal-care': <path d="M12 3.2s5.9 6.2 5.9 9.9a5.9 5.9 0 0 1-11.8 0c0-3.7 5.9-9.9 5.9-9.9Z" />,
  person: (
    <>
      <circle cx="12" cy="7.6" r="3.7" />
      <path d="M4.6 20.4a7.4 7.4 0 0 1 14.8 0" />
    </>
  ),
  people: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3 19.6a6 6 0 0 1 12 0" />
      <path d="M16.2 5.2a3.2 3.2 0 0 1 0 5.6" />
      <path d="M17.4 14.2a6 6 0 0 1 3.6 5.4" />
    </>
  ),
  transfers: (
    <>
      <path d="M4 8.4h13" />
      <path d="M14 5.4 17 8.4 14 11.4" />
      <path d="M20 15.6H7" />
      <path d="M10 12.6 7 15.6 10 18.6" />
    </>
  ),
  income: (
    <>
      <path d="M12 3.4v10.8" />
      <path d="M8 10.4 12 14.4 16 10.4" />
      <path d="M4.2 16.6v2.2a2 2 0 0 0 2 2h11.6a2 2 0 0 0 2-2v-2.2" />
    </>
  ),
  investment: (
    <>
      <path d="M3.4 17.6 9 12l3.6 3.6L20.6 7.6" />
      <path d="M15.4 7.6h5.2v5.2" />
    </>
  ),
  savings: (
    <>
      <path d="M3.4 12.6a6.6 6.6 0 0 1 6.6-6.6h3.4a6.6 6.6 0 0 1 6.6 6.6v2a2 2 0 0 1-2 2h-.6V20h-3v-3.4H8.6V20h-3v-4.2a6.5 6.5 0 0 1-2.2-3.2Z" />
      <circle cx="16.6" cy="11.4" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  cash: (
    <>
      <rect x="2.8" y="6.4" width="18.4" height="11.2" rx="2" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  card: (
    <>
      <rect x="2.8" y="5.4" width="18.4" height="13.2" rx="2.4" />
      <path d="M2.8 10h18.4" />
      <path d="M6.2 14.6h3.4" />
    </>
  ),
  loan: (
    <>
      <path d="M3 9.6 12 4.4l9 5.2" />
      <path d="M5.4 10.6v7.2M10 10.6v7.2M14 10.6v7.2M18.6 10.6v7.2" />
      <path d="M3.4 20.4h17.2" />
    </>
  ),
  insurance: (
    <>
      <path d="M12 3.2 19.6 6v6c0 4.3-3.1 7.5-7.6 8.8C7.5 19.5 4.4 16.3 4.4 12V6L12 3.2Z" />
      <path d="M9.2 12.2 11.3 14.3 15 10.6" />
    </>
  ),
  gift: (
    <>
      <rect x="3.4" y="9.6" width="17.2" height="4" rx="1" />
      <path d="M5 13.6V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-6.4" />
      <path d="M12 9.6V21" />
      <path d="M12 9.6S10.8 4 8.4 4a2.2 2.2 0 0 0 0 5.6M12 9.6S13.2 4 15.6 4a2.2 2.2 0 0 1 0 5.6" />
    </>
  ),
  travel: (
    <>
      <path d="M21.2 2.8 2.8 10.4l7.4 3.1 3.1 7.4L21.2 2.8Z" />
      <path d="M10.2 13.5 21.2 2.8" />
    </>
  ),
  fuel: (
    <>
      <path d="M4.4 20.6V5.4a2 2 0 0 1 2-2h4.8a2 2 0 0 1 2 2v15.2" />
      <path d="M3.2 20.6h11.2" />
      <path d="M4.4 11.6h8.8" />
      <path d="M13.2 8.2l3 2.4v7a1.8 1.8 0 0 0 3.6 0V10l-2.4-3" />
    </>
  ),
  phone: (
    <>
      <rect x="6.4" y="2.6" width="11.2" height="18.8" rx="2.6" />
      <path d="M10.6 18.2h2.8" />
    </>
  ),
  wifi: (
    <>
      <path d="M2.6 9.4a13.4 13.4 0 0 1 18.8 0" />
      <path d="M6 13a8.6 8.6 0 0 1 12 0" />
      <path d="M9.4 16.6a3.8 3.8 0 0 1 5.2 0" />
      <circle cx="12" cy="20" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  subscription: (
    <>
      <path d="M20.4 12a8.4 8.4 0 1 1-2.5-6" />
      <path d="M20.6 3.6v4.8h-4.8" />
    </>
  ),
  coffee: (
    <>
      <path d="M4 8.4h12v6a4.6 4.6 0 0 1-9.2 0" />
      <path d="M4 8.4v6a4.6 4.6 0 0 0 2.8 4.2" />
      <path d="M16 10h1.8a2.6 2.6 0 0 1 0 5.2H16" />
      <path d="M4.4 21h13" />
    </>
  ),
  fitness: (
    <>
      <path d="M4.4 9.2v5.6M7.2 7.4v9.2M16.8 7.4v9.2M19.6 9.2v5.6" />
      <path d="M7.2 12h9.6" />
    </>
  ),
  pet: (
    <>
      <circle cx="5.6" cy="11" r="2" />
      <circle cx="9.8" cy="6.6" r="2" />
      <circle cx="14.6" cy="6.6" r="2" />
      <circle cx="18.6" cy="11" r="2" />
      <path d="M12.2 12.8c2.7 0 4.9 2.1 4.9 4.3 0 1.8-1.6 2.9-3.3 2.4l-1.6-.5-1.6.5c-1.7.5-3.3-.6-3.3-2.4 0-2.2 2.2-4.3 4.9-4.3Z" />
    </>
  ),
  happy: (
    <>
      <circle cx="12" cy="12" r="8.8" />
      <path d="M9 10.4h.01M15 10.4h.01" />
      <path d="M9.2 14.6a4 4 0 0 0 5.6 0" />
    </>
  ),
  plant: (
    <>
      <path d="M12 21v-7.2" />
      <path d="M12.2 13.8C12.2 9.3 15.8 5.7 20.3 5.7c0 4.5-3.6 8.1-8.1 8.1Z" />
      <path d="M11 13.8a6.2 6.2 0 0 0-6.2-6.2c0 3.4 2.8 6.2 6.2 6.2Z" />
    </>
  ),
  laundry: (
    <>
      <rect x="4" y="2.8" width="16" height="18.4" rx="2.4" />
      <circle cx="12" cy="14" r="4.4" />
      <path d="M7.4 6.4h.01M10.6 6.4h.01" />
    </>
  ),
  book: (
    <>
      <path d="M4.4 4.4A2 2 0 0 1 6.4 2.4H19v16.4H6.4a2 2 0 0 0-2 2Z" />
      <path d="M4.4 18.8a2 2 0 0 1 2-2H19" />
    </>
  ),
  music: (
    <>
      <path d="M9.2 18V5.6l10-2v12" />
      <circle cx="6.6" cy="18" r="2.6" />
      <circle cx="16.6" cy="15.6" r="2.6" />
    </>
  ),
  camera: (
    <>
      <path d="M3.4 8.6a2 2 0 0 1 2-2h2.4l1.4-2.2h5.6l1.4 2.2h2.4a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5.4a2 2 0 0 1-2-2Z" />
      <circle cx="12" cy="12.8" r="3.4" />
    </>
  ),
  charity: (
    <>
      <path d="M12 20.4S4.4 15.4 4.4 10.2a3.9 3.9 0 0 1 7.6-1.4 3.9 3.9 0 0 1 7.6 1.4c0 5.2-7.6 10.2-7.6 10.2Z" />
      <path d="M12 3.2v2" />
    </>
  ),
  tax: (
    <>
      <path d="M5.4 2.8h13.2v18.4l-2.2-1.6-2.2 1.6-2.2-1.6-2.2 1.6-2.2-1.6-2.2 1.6Z" />
      <path d="M8.6 8h6.8M8.6 12h6.8M8.6 16h4" />
    </>
  ),
  party: (
    <>
      <path d="M3.2 20.8 8.4 7.6l8 8-13.2 5.2Z" />
      <path d="M14.4 3.6v2.2M19.6 8.8h-2.2M18.6 4.6l-1.6 1.6" />
    </>
  ),
  other: (
    <>
      <circle cx="12" cy="12" r="8.8" />
      <circle cx="8.4" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
      <circle cx="15.6" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
}

/** Every glyph the "New category" sheet offers, defaults first. */
export const ICON_NAMES = Object.keys(ICONS)

/** The glyph alone, by icon name, taking its colour from the parent. */
export function Glyph({ icon }) {
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
      {ICONS[icon] ?? ICONS.other}
    </svg>
  )
}

/** Rounded tile, built the way Wise builds their colour cards: the bright
 *  pastel carries the panel, forest green carries the content. Because the
 *  glyph colour never changes, contrast holds on white and on #121511 alike —
 *  a pastel-on-pastel tile would have vanished on the light theme.
 *
 *  Pass `icon`/`color` to preview a category that does not exist yet. */
export default function CategoryIcon({ category, className = 'tile', icon, color }) {
  return (
    <span
      className={className}
      style={{ background: color ?? colorFor(category), color: '#163300' }}
    >
      <Glyph icon={icon ?? iconFor(category)} />
    </span>
  )
}
