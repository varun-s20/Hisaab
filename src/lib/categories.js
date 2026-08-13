// Fourteen built in. Resist adding more to this list — categories you don't use
// become noise. Anything genuinely missing is a custom one, below.
export const CATEGORIES = [
  'Food & Dining',
  'Groceries',
  'Transport',
  'Shopping',
  'Bills & Utilities',
  'Rent',
  'Health',
  'Entertainment',
  'Education',
  'Personal Care',
  'Household Help',
  'Transfers',
  'Income',
  'Other',
]

// One colour per category, used for the icon tile and the donut. Wise's
// secondary palette, read off their live tokens — every hex here is theirs
// except the two marked (derived): Wise has no mid-tone lavender or warm grey,
// and fourteen categories need fourteen separable dots.
export const CATEGORY_COLOR = {
  'Food & Dining': '#FFC091', // bright orange
  Groceries: '#9FE870', // bright green
  Transport: '#A0E1E1', // bright blue
  Shopping: '#FFD7EF', // bright pink
  'Bills & Utilities': '#51C8C8', // teal
  Rent: '#FFEB69', // bright yellow
  Health: '#FF8787', // negative base
  Entertainment: '#C6A8D9', // (derived) tint of Wise dark purple #260A2F
  Education: '#FADC65', // gold
  'Personal Care': '#FFD1D3', // pale red
  'Household Help': '#C5EDAB', // light green
  Transfers: '#D0D5CE', // neutral, greenish
  Income: '#CDFFAD', // bright green hover
  Other: '#E7E7E1', // neutral
}

// Every value above is light enough to carry forest green on top — that is the
// Wise pattern (bright pastel panel, #163300 content) and the reason the icon
// tiles stay legible on both the white and the #121511 screen.

/** What a new category can be painted. Same rule: light enough for #163300. */
export const PICKABLE_COLORS = [
  '#FFC091', '#9FE870', '#A0E1E1', '#FFD7EF', '#51C8C8', '#FFEB69',
  '#FF8787', '#C6A8D9', '#FADC65', '#FFD1D3', '#C5EDAB', '#77D4D4',
  '#FFA8AD', '#B6ECEC', '#D0D5CE', '#E7E7E1',
]

// The glyph each built-in wears. Names index the ICONS registry in
// components/CategoryIcon.jsx, which is also what the "New category" sheet
// offers — so every default icon is pickable for a category you invent, which
// it wasn't when the glyphs were keyed by category name.
export const CATEGORY_ICON = {
  'Food & Dining': 'food',
  Groceries: 'groceries',
  Transport: 'transport',
  Shopping: 'shopping',
  'Bills & Utilities': 'bills',
  Rent: 'rent',
  Health: 'health',
  Entertainment: 'entertainment',
  Education: 'education',
  'Personal Care': 'personal-care',
  // Was a pair of sparkles, which reads as "magic", not as the person who
  // cooks and cleans. A person is the subject of this category.
  'Household Help': 'person',
  Transfers: 'transfers',
  Income: 'income',
  Other: 'other',
}

// ── Custom categories ──────────────────────────────────────────────────────
//
// Stored in the `categories` table, mirrored to localStorage.
//
// This used to be localStorage alone, on the reasoning that the category value
// is already written onto every transaction so nothing was lost across devices
// — "only the picker list, which is a preference". That reasoning was wrong and
// the bug was exactly what it predicts: reinstall the app, and a category you
// made still shows on every row it was filed under, because the NAME is on the
// row. But colorFor() and iconFor() find nothing and fall through to Other's
// grey and the fallback glyph, and isCustom() returns false so the remove
// button vanishes too. Your category came back as grey text you could not
// delete.
//
// The mirror stays, demoted to a cache. It is what makes the first paint
// correct — every picker and every row icon reads these synchronously, and
// waiting on a network round trip before drawing would flash the whole ledger
// grey on every launch. It is also what keeps the app right when the backend is
// offline or paused.
const KEY = 'hisaab.categories'
// Who the list on this device belongs to. Custom category names are not a
// neutral preference — "Therapy", "Mum's medicines", "Divorce lawyer" — and
// localStorage outlives a sign-out. Without this, the next person to sign in on
// a shared phone gets the last one's list in every picker, and Ask sends it to
// the model as if it were theirs (see allCategories() in src/screens/Ask.jsx).
const OWNER = 'hisaab.categories.owner'

let cache = null

function read() {
  if (cache) return cache
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    cache = Array.isArray(raw)
      ? raw.filter((c) => c && typeof c.name === 'string' && !CATEGORIES.includes(c.name))
      : []
  } catch {
    cache = []
  }
  return cache
}

function write(next) {
  cache = next
  localStorage.setItem(KEY, JSON.stringify(next))
}

/**
 * Called on every auth change with the signed-in user's id. A different owner
 * than the one this device last saw means the list belongs to someone else:
 * drop it rather than show it to whoever just signed in.
 *
 * Signing out passes nothing and wipes nothing — the same person signing back
 * in keeps their list. It goes when a *different* account arrives.
 *
 * ponytail: the list is lost when a device changes hands, because it lives on
 * the device. Move it to a `categories` table if it should follow the account
 * instead — the category value is already on every row, so only the picker
 * list is at stake.
 */
export function setOwner(userId) {
  if (!userId) return
  try {
    if (localStorage.getItem(OWNER) === userId) return
    localStorage.removeItem(KEY)
    localStorage.setItem(OWNER, userId)
  } catch {
    // Storage blocked. Nothing was persisted to leak in the first place.
  }
  cache = null
}

/** [{ name, color, icon }] — the ones the user made. Synchronous on purpose;
 *  see the note above the mirror. */
export const customCategories = () => read()

/** Built-ins first, then the user's own. This is what every picker shows. */
export const allCategories = () => [...CATEGORIES, ...read().map((c) => c.name)]

/**
 * Pull the real list from whichever backend is live, and adopt anything this
 * device has that the backend does not.
 *
 * The adoption step is what carries existing users across. Their categories are
 * sitting in localStorage on the phone they made them on, and this is the one
 * moment that can still see them — miss it and "Therapy" is gone the next time
 * they clear their browser. It runs once per launch and is a no-op after the
 * first, because by then the backend has them.
 *
 * Called from App.jsx on sign-in, beside loadMerchantMap. Failure is quiet: the
 * mirror is already loaded, so an offline launch keeps every colour and glyph
 * it had yesterday.
 */
export async function loadCategories() {
  const { listCategories, upsertCategory } = await import('./db.js')
  const stored = await listCategories()
  const known = new Set(stored.map((c) => c.name))

  const orphaned = read().filter((c) => !known.has(c.name))
  for (const c of orphaned) {
    try {
      await upsertCategory({ name: c.name, color: c.color, icon: c.icon })
      stored.push(c)
    } catch {
      // Keep it in the mirror and try again next launch rather than dropping
      // a category on the floor because one write failed.
    }
  }

  write(stored.map((c) => ({ name: c.name, color: c.color, icon: c.icon })))
  return read()
}

// '*' is the reserved category the budgets table uses for the whole-month cap
// (see db/schema.sql). A custom category by that name would upsert straight
// onto the sentinel row and silently become the total budget.
const RESERVED = ['*']

/**
 * Async now, because the category has to reach the database before it can be
 * called saved. The mirror is written first so the picker updates on the same
 * tick — and rolled back if the write fails, rather than showing a category
 * that only exists on this phone, which is the bug this whole change is about.
 */
export async function addCategory(name, color, icon) {
  const clean = String(name).trim().slice(0, 28)
  if (!clean) throw new Error('A name is needed.')
  if (RESERVED.includes(clean)) throw new Error('That name is reserved.')
  if (allCategories().some((c) => c.toLowerCase() === clean.toLowerCase())) {
    throw new Error('That category already exists.')
  }

  const row = { name: clean, color: color || '#E7E7E1', icon: icon || 'other' }
  const before = read()
  write([...before, row])
  try {
    const { upsertCategory } = await import('./db.js')
    await upsertCategory(row)
  } catch (e) {
    write(before)
    throw new Error(`“${clean}” could not be saved. ${e?.message ?? ''}`.trim())
  }
  return clean
}

/** Removing a category never touches the rows already filed under it — they
 *  keep the text and simply stop being offered in the picker. */
export async function removeCategory(name) {
  const before = read()
  write(before.filter((c) => c.name !== name))
  try {
    const { deleteCategory } = await import('./db.js')
    await deleteCategory(name)
  } catch (e) {
    write(before)
    throw new Error(`“${name}” could not be removed. ${e?.message ?? ''}`.trim())
  }
}

export const colorFor = (c) =>
  CATEGORY_COLOR[c] ?? read().find((x) => x.name === c)?.color ?? CATEGORY_COLOR.Other

/** Which glyph a category wears: a built-in's own, a custom one's choice, or
 *  the fallback dots. */
export const iconFor = (c) =>
  CATEGORY_ICON[c] ?? read().find((x) => x.name === c)?.icon ?? 'other'

export const isCustom = (c) => !CATEGORIES.includes(c) && read().some((x) => x.name === c)

// Types that are real spending. Everything else is money moving, not leaving.
export const SPEND_TYPES = ['expense']
/** Money genuinely arriving. A transfer in is not income, it is your own money. */
export const EARN_TYPES = ['income', 'refund', 'repaid']
/** Money you put away rather than spent — SIPs, mutual funds, an RD. Counted in
 *  neither spending nor income, and given its own view on Insights. Needs
 *  db/migrate-investment.sql to have been run, or the CHECK rejects the write. */
export const INVEST_TYPES = ['investment']
export const TYPES = ['expense', 'income', 'investment', 'transfer', 'refund', 'lent', 'repaid']

/** The types that land in some total on some screen. Anything outside this is
 *  money moving between your own pockets and shows up in no figure — which is
 *  the single most surprising thing about this app, so every type control in it
 *  says so out loud. */
export const COUNTED = new Set([...SPEND_TYPES, ...EARN_TYPES, ...INVEST_TYPES])

/** The type list as the picker shows it. The bare word never explained which
 *  of these land in a total and which vanish from every figure, which is the
 *  only thing anyone needs to know when choosing one. */
export const TYPE_OPTIONS = [
  { value: 'expense', label: 'Expense', sub: 'Money spent. Counts as spending.' },
  { value: 'income', label: 'Income', sub: 'Money earned. Counts as money in.' },
  { value: 'investment', label: 'Investment', sub: 'Put away, not spent. Its own view on Insights.' },
  { value: 'transfer', label: 'Transfer', sub: 'Your own money moving. In no total.' },
  { value: 'refund', label: 'Refund', sub: 'Money back. Counts as money in.' },
  { value: 'lent', label: 'Lent', sub: 'Out, but you expect it back. In no total.' },
  { value: 'repaid', label: 'Repaid', sub: 'Paid back to you. Counts as money in.' },
]

export const DIRECTIONS = [
  { value: 'debit', label: 'Money out' },
  { value: 'credit', label: 'Money in' },
]
