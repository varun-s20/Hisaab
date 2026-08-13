// Extensions are explicit throughout. Vite resolves without them; plain node
// does not, and scripts/test-backends.mjs imports this file directly.
import { currentUserId } from './auth.js'
import { DEFAULT, readConfig } from './backend.js'
import { createBackend } from './backends/index.js'
import { synthRef } from './parse.js'
import { normalise } from './seeds.js'
import { today } from './format.js'

// The ledger, whichever backend it lives in.
//
// Every screen imports from this file and none of them knows or cares where the
// rows are — Hisaab's Supabase, the user's own Supabase, or IndexedDB on the
// phone. lib/backends/* implement fifteen operations; everything below that is
// either dispatch or computation done here, once, for all three.
//
// The rule that keeps this honest: the backend interface takes ids and rows,
// never filter expressions. The moment it accepts a predicate, the local
// backend needs a query parser, and a query parser that is subtly wrong is
// wrong about somebody's money on a screen that looks fine.

// ── Which backend is live ──────────────────────────────────────────────────

let adapter = null
let pending = null
let activeConfig = DEFAULT

/** The live backend, opening it on first use. */
function db() {
  if (adapter) return Promise.resolve(adapter)
  if (!pending) {
    pending = (async () => {
      const userId = await currentUserId()
      activeConfig = readConfig(userId)
      adapter = await createBackend(activeConfig, userId)
      return adapter
    })().catch((e) => {
      // A failed open must not be cached as a permanent state — a paused
      // project that gets woken up, or a phone that regains storage, should
      // work on the next call rather than for the next reload.
      pending = null
      throw e
    })
  }
  return pending
}

/** What the app is currently reading and writing. For the settings screen. */
export const activeBackendConfig = () => activeConfig

/** The live backend itself. Only two callers should ever want this: the
 *  settings screen, which hands it to lib/migrate.js as the source of a
 *  switch, and a backup. Everything else goes through the functions below. */
export const activeAdapter = () => db()

/**
 * Every transaction, for a backup or a switch — no window, no projection.
 *
 * A separate name from listTransactions because the ceiling is different and
 * the difference matters: this one is what a person's only copy is written
 * from, so trimming it to a screen's worth would be silent data loss in a file
 * named "backup".
 */
export async function snapshotTransactions() {
  return (await db()).listAllTransactions({ limit: 50_000 })
}

/**
 * Point the app at a backend that is already open.
 *
 * A switch verifies the destination and copies rows into it before it commits,
 * so by the time the app should start reading from it the connection has been
 * made and tested. Installing that same instance avoids opening it twice — and
 * on a BYO project, a second open means a second sign-in round trip.
 */
export function installBackend(next, config = DEFAULT) {
  forgetAccounts()
  adapter = next
  pending = Promise.resolve(next)
  activeConfig = config
  return next
}

/**
 * Point the app at a different backend, now.
 *
 * Throws if it cannot be reached, leaving the previous backend in place — a
 * failed switch must not strand someone on a backend that does not answer.
 */
export async function useBackend(config, userId) {
  return installBackend(await createBackend(config, userId), config)
}

// ── Row shaping ────────────────────────────────────────────────────────────

/**
 * numeric(12,2) tops out just under ten billion. An OCR'd account number that
 * landed in an amount slot, or a junk column in a 500-row CSV, is not a rupee
 * figure — store nothing and let the row surface in "Needs a look". Postgres
 * would otherwise raise `numeric field overflow` and reject the entire batch
 * the bad row arrived in.
 *
 * Enforced here rather than in a backend so the local store holds the same
 * range Postgres does, and a migration between them can never fail on a value
 * one accepted and the other will not.
 */
const MAX_AMOUNT = 9_999_999_999.99

function safeAmount(v) {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 && n <= MAX_AMOUNT ? n : null
}

/** Drop the leading-underscore working fields the cascade adds. */
function forInsert(t) {
  const amount = safeAmount(t.amount)
  // Anything we couldn't store an amount for is worth a look, including a row
  // whose parsed amount was out of range.
  //
  // A row the parser couldn't date is worth a look too, and used not to be: the
  // date penalty alone lands confidence on exactly 0.7, and the flag is
  // `confidence < 0.7`, so a dateless row slipped through unflagged and silently
  // took today's date below. That is how a Tuesday payment showed up on
  // Wednesday's Today screen with nothing on the row saying the date was
  // invented.
  const needs_review = Boolean(t.needs_review) || amount == null || t.txn_date == null

  return {
    txn_ref: t.txn_ref || synthRef({ ...t, amount }),
    // txn_date is NOT NULL in the schema. A row the parser couldn't date lands
    // on today, flagged — the date is the one field a person can always
    // reconstruct from the screenshot.
    txn_date: t.txn_date ?? today(),
    txn_time: t.txn_time ?? null,
    amount,
    direction: t.direction ?? 'debit',
    // Whatever the cascade decided, kept as-is. This used to force 'transfer'
    // on every amount-less row on the grounds that it "is not yet a claim about
    // spending" — but the amount is null, so it contributes 0 to every total
    // either way, and the type survived the trip through "Needs a look": you
    // filled in the amount, pressed Save, and six confirmed payments landed as
    // transfers, which every screen in the app excludes from every figure.
    type: t.type ?? 'expense',
    payee_raw: t.payee_raw,
    payee_clean: t.payee_clean ?? null,
    category: t.category ?? null,
    method: t.method ?? null,
    account: t.account ?? null,
    // Only a transfer has one. Kept off everything else so "group by account"
    // and every balance below can treat a non-null value as money arriving.
    to_account: t.type === 'transfer' || t.category === 'Transfers' ? (t.to_account ?? null) : null,
    source: t.source ?? 'screenshot',
    confidence: t.confidence ?? 1.0,
    needs_review,
    note: t.note ?? null,
    // Only kept where it is actually read — the "What the app read" panel in
    // Review. Storing the full OCR dump on every row would put UPI reference
    // numbers, account names and running balances in the database for rows
    // nobody will ever look at, which is not what the app tells the user it
    // stores. Review clears it when the row leaves the queue.
    raw_text: needs_review ? (t.raw_text ?? null) : null,
  }
}

// ── Writing ────────────────────────────────────────────────────────────────

/**
 * Insert a batch, skipping anything whose txn_ref already exists.
 *
 * Dedup is checked before the write so we can *report* the skip count. The
 * backend enforces it again — a unique index on Postgres, an explicit check in
 * the local store — which is what covers the race between the check and the
 * write.
 */
export async function saveTransactions(txns) {
  const backend = await db()

  // A row only needs something to identify it. A missing amount is stored as
  // null and surfaces in "Needs a look" — dropping it here would lose the
  // transaction entirely, leaving the user a count and no way to recover it.
  const usable = txns.filter((t) => t.payee_raw && (t.amount || t.raw_text))
  const unusable = txns.length - usable.length
  if (usable.length === 0) {
    return { saved: 0, duplicates: 0, unusable, unreadable: 0, rejected: 0, rows: [] }
  }

  const rows = usable.map(forInsert)
  const unreadable = rows.filter((r) => r.amount == null).length

  const seen = await backend.findExistingRefs(rows.map((r) => r.txn_ref))

  // Same screenshot twice inside one upload counts as a duplicate too.
  const fresh = []
  const batchSeen = new Set()
  for (const r of rows) {
    if (seen.has(r.txn_ref) || batchSeen.has(r.txn_ref)) continue
    batchSeen.add(r.txn_ref)
    fresh.push(r)
  }
  const duplicates = rows.length - fresh.length
  if (fresh.length === 0) {
    return { saved: 0, duplicates, unusable, unreadable, rejected: 0, rows: [] }
  }

  const { saved, rejected } = await backend.insertTransactions(fresh)
  forgetAccounts() // an import is how most accounts arrive
  return { saved: saved.length, duplicates, unusable, unreadable, rejected, rows: saved }
}

export async function updateTransaction(id, patch) {
  const backend = await db()
  const [row] = await backend.updateTransactions([id], patch)
  if ('account' in patch || 'method' in patch) forgetAccounts()
  return row ?? null
}

export async function deleteTransaction(id) {
  await (await db()).deleteTransactions([id])
}

/** Undo an import. Deleting by the ids the insert handed back is exact — a
 *  date range would also take rows that were already there. */
export async function deleteTransactions(ids) {
  if (!ids?.length) return 0
  return (await db()).deleteTransactions(ids)
}

// ── Reading ────────────────────────────────────────────────────────────────

export async function listTransactions({ from, to, limit = 500 } = {}) {
  return (await db()).listTransactions({ from, to, limit })
}

export async function listNeedsReview() {
  return (await db()).listNeedsReview()
}

export async function countNeedsReview() {
  try {
    return await (await db()).countNeedsReview()
  } catch {
    return 0
  }
}

// ── Derived lists, computed here for every backend ─────────────────────────

/** The payment rails actually present in this ledger — gpay, phonepe, cash,
 *  NEFT, or a card you named yourself. Ask needs the real list so a question
 *  can name one, and so the model is never told about apps you don't use. */
let methodCache = null

export async function listMethods() {
  if (methodCache) return methodCache
  try {
    const rows = await (await db()).listAllTransactions({ limit: 2000, columns: ['method'] })
    methodCache = [...new Set(rows.map((r) => r.method).filter(Boolean))].sort()
    return methodCache
  } catch {
    return []
  }
}

/**
 * The accounts actually present in this ledger — "HDFC card", "SBI", or the
 * envelopes a budgeting-app import brought with it: Needs, Wants, Savings,
 * Recurring Payments.
 *
 * ponytail: derived, never stored. There is no accounts table and nothing in
 * localStorage, so there is no list to keep in sync across devices, nothing to
 * migrate, and no delete flow to build — stop using an account and it leaves on
 * its own. Typing a new one in the picker is how you make it, and it is real
 * from the moment a row carries it.
 *
 * Both sides are read. An envelope you have only ever funded — money in,
 * nothing spent yet — is still an account, and reading `account` alone made it
 * invisible until the first time you paid from it.
 */
let accountCache = null

export async function listAccounts() {
  if (accountCache) return accountCache
  try {
    const backend = await db()
    const wide = backend.capabilities().toAccount
    const rows = await backend.listAllTransactions({
      limit: 2000,
      columns: wide ? ['account', 'to_account'] : ['account'],
    })
    const seen = new Set()
    for (const r of rows) {
      if (r.account) seen.add(r.account)
      if (r.to_account) seen.add(r.to_account)
    }
    accountCache = [...seen].sort()
    return accountCache
  } catch {
    // Degrades rather than throws: EditSheet asks for this, and a database that
    // cannot be reached must not make editing a row impossible.
    return []
  }
}

/**
 * What is left in each account: everything that arrived, minus everything that
 * left. The number an envelope budgeter checks daily.
 *
 *   in   transfers whose to_account is this one, and credits landing in it
 *   out  every debit from it, spending and transfers out alike
 *
 * A `transfer` counts on both sides here and in no spending total anywhere
 * else, which is the point of the type: moving your own money changes where it
 * is without changing how much of it there is.
 *
 * ponytail: summed on the device over the narrowest possible read. An aggregate
 * would need a Postgres function and a migration to go with it — and would then
 * need writing a second time for the local backend. This is five columns and
 * stays correct while a ledger is small enough to hold. The 5000 ceiling is
 * stated in the caller — Budgets says so on screen.
 */
export const BALANCE_ROWS = 5000

/**
 * The ceiling for anything that REWRITES rows rather than summing them.
 *
 * Separate from BALANCE_ROWS, and much higher, because the two are wrong in
 * different ways when they run out. A balance computed over the most recent
 * 5000 rows is a stated approximation that the screen says out loud. A merchant
 * lesson applied to the most recent 5000 rows is a silent lie: the toast says
 * "past payments included", and every payment older than that keeps the wrong
 * category with nothing on screen to suggest it. These used to share the 5000,
 * which the SQL version they replaced never did — a predicated UPDATE has no
 * ceiling at all.
 */
const REWRITE_ROWS = 50_000

export async function accountBalances() {
  const backend = await db()
  if (!backend.capabilities().toAccount) {
    throw new Error('Run db/migrate-accounts.sql — this screen needs the to_account column.')
  }
  const rows = await backend.listAllTransactions({
    limit: BALANCE_ROWS,
    columns: ['account', 'to_account', 'amount', 'direction', 'type'],
  })

  const acc = new Map()
  const at = (name) => {
    if (!acc.has(name)) acc.set(name, { account: name, in: 0, out: 0, count: 0 })
    return acc.get(name)
  }

  for (const r of rows) {
    const n = Number(r.amount)
    if (!Number.isFinite(n)) continue
    // A destination only means "money arrived here" on a row that is actually a
    // move between two of your own pockets. On a credit-direction row it would
    // otherwise be counted twice — once into `account` as money in, once into
    // `to_account` — inventing a rupee that never existed.
    if (r.to_account && r.type === 'transfer') at(r.to_account).in += n
    if (!r.account) continue
    const a = at(r.account)
    a.count += 1
    if (r.direction === 'credit') a.in += n
    else a.out += n
  }

  return [...acc.values()]
    .map((a) => ({ ...a, balance: a.in - a.out }))
    .sort((a, b) => b.balance - a.balance)
}

/**
 * Fold one account into another, everywhere it appears.
 *
 * Free text fragments even behind a picker: an import brings "SBI Bank" and you
 * later type "SBI". Both sides are rewritten, because a transfer names an
 * account in `to_account` and renaming only the source would leave the other
 * half pointing at a name that no longer exists.
 *
 * Read, decide here, write by id. The predicate version of this
 * (`update … where account = from`) is the kind of thing only PostgREST can do,
 * and teaching the local backend to do it would mean a filter parser. Costs one
 * extra read; keeps one implementation.
 */
export async function mergeAccount(from, to) {
  const target = to?.trim() || null
  if (!from || from === target) return 0

  const backend = await db()
  const wide = backend.capabilities().toAccount
  const rows = await backend.listAllTransactions({
    // A rewrite, not a sum. Folding "SBI Bank" into "SBI" and leaving the older
    // half of the ledger still naming the old one would split the account it
    // was meant to merge, and the balances screen would show both.
    limit: REWRITE_ROWS,
    columns: wide ? ['id', 'account', 'to_account'] : ['id', 'account'],
  })

  // Three shapes of patch, so three groups. A row naming `from` on both sides
  // is a transfer to itself and needs both rewritten in one update, or the
  // second write would find nothing left to match.
  const both = []
  const source = []
  const destination = []
  for (const r of rows) {
    const isSource = r.account === from
    const isDestination = wide && r.to_account === from
    if (isSource && isDestination) both.push(r.id)
    else if (isSource) source.push(r.id)
    else if (isDestination) destination.push(r.id)
  }

  await backend.updateTransactions(both, { account: target, to_account: target })
  await backend.updateTransactions(source, { account: target })
  await backend.updateTransactions(destination, { to_account: target })

  // A cap set on the old name would otherwise sit there capping nothing.
  // Untouched where an account cap cannot exist.
  if (backend.capabilities().budgetScope) {
    await backend.deleteBudget({ scope: 'account', category: from })
  }
  forgetAccounts()
  return both.length + source.length + destination.length
}

/** Both lists are read off the rows, so both go stale the moment a row is
 *  written. saveTransactions and updateTransaction are the only two writers. */
const forgetAccounts = () => {
  accountCache = null
  methodCache = null
}

/**
 * The same wipe, for a change of user rather than a change of row — and for a
 * change of backend, which is a change of every row at once.
 *
 * These caches are somebody's bank, card and envelope names, held in module
 * variables that survive a sign-out: the tab is never reloaded, App.jsx just
 * swaps the screen. Signing in as someone else therefore showed the previous
 * person's accounts in every picker, and Ask sent them to the model as the new
 * person's (src/screens/Ask.jsx passes listAccounts() straight to /api/ask).
 *
 * The backend goes with them, for the same reason and one more: it may be a
 * client authenticated as the person who just left.
 */
export function forgetCaches() {
  forgetAccounts()
  adapter = null
  pending = null
  activeConfig = DEFAULT
}

// ── Budgets ────────────────────────────────────────────────────────────────
// Category '*' is the cap for the whole month. See db/schema.sql.
export const TOTAL_BUDGET = '*'

// `scope` says whether the `category` column is naming a category or an
// account. Envelope budgeting caps the pocket rather than the kind of spending:
// "₹7,500 into Wants this month" is the decision people actually make, and
// which categories it lands on is the consequence.
export async function listBudgets() {
  return (await db()).listBudgets()
}

export async function setBudget(category, amount, scope = 'category') {
  return (await db()).upsertBudget({ scope, category, amount })
}

export async function removeBudget(category, scope = 'category') {
  return (await db()).deleteBudget({ scope, category })
}

// ── Categories the user made ───────────────────────────────────────────────
// The fourteen built-ins are in lib/categories.js and are not rows. These are
// only the ones somebody invented, and they are stored rather than remembered
// so that "Therapy" comes back on a new phone as itself — its colour, its
// glyph, and removable — instead of as grey text nobody can get rid of.

export async function listCategories() {
  return (await db()).listCategories()
}

export async function upsertCategory(row) {
  return (await db()).upsertCategory(row)
}

export async function deleteCategory(name) {
  return (await db()).deleteCategory(name)
}

// ── Merchant map, as data you can see and correct ──────────────────────────

export async function listMerchantMap() {
  return (await db()).listMerchantMap()
}

/** Used by lib/categorise.js, which no longer talks to a database itself. */
export async function upsertMerchantMapping(row, options) {
  return (await db()).upsertMerchantMapping(row, options)
}

/** Forget a mapping. The transactions keep their category; the merchant simply
 *  becomes teachable again, which is the point of doing this at all. */
export async function deleteMerchantMapping(payee_pattern) {
  return (await db()).deleteMerchantMapping(payee_pattern)
}

/**
 * Merchants seen in transactions that the map doesn't know yet.
 *
 * ponytail: scans a window of recent rows rather than asking the database to
 * filter. One narrow read serves this, and the same code serves a backend with
 * no query language at all. The window is the ceiling: a merchant last seen
 * beyond it stops being offered, which for a "teach me the recent ones" queue
 * is the right end to truncate.
 */
const UNTAUGHT_WINDOW = 1000

export async function listUntaught(limit = 25) {
  const rows = await (await db()).listAllTransactions({
    limit: UNTAUGHT_WINDOW,
    columns: ['payee_raw', 'category', 'amount', 'txn_date', 'type'],
  })

  const groups = new Map()
  for (const r of rows) {
    if (r.type === 'transfer') continue
    if (r.category && r.category !== 'Other') continue
    if (!r.payee_raw) continue
    const g = groups.get(r.payee_raw) ?? { payee_raw: r.payee_raw, count: 0, total: 0 }
    g.count += 1
    g.total += Number(r.amount) || 0
    groups.set(r.payee_raw, g)
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, limit)
}

/** How many merchants are waiting in "Teach me". Same query as listUntaught —
 *  the screen was the only thing that knew there was anything to do, so nobody
 *  opened it. */
export async function countUntaught() {
  try {
    return (await listUntaught(500)).length
  } catch {
    return 0
  }
}

/**
 * Apply a taught category to every existing row for that merchant.
 *
 * The type is stamped on debits only. A category has one default type, and
 * Amazon's five debits and one refund are all `payee_raw = 'AMAZON'` — writing
 * `expense` across the lot would book a ₹2,000 refund as ₹2,000 spent, in both
 * directions at once: spending up by the refund, money-in down by the same.
 * A credit was already typed correctly at import (income / refund / repaid);
 * teaching the merchant's category is not new information about its direction.
 *
 * Only rows whose type was a default get a new one. 'investment', 'lent' and
 * 'refund' are things a person sat down and said about a specific row, and a
 * later lesson about the merchant's *category* is not new information about any
 * of them — teaching "SIP" used to flatten every investment under that merchant
 * back to an expense.
 */
async function recategoriseRaws(raws, { category, payee_clean, type }) {
  if (!raws.length) return 0
  const backend = await db()
  const wanted = new Set(raws)
  const rows = await backend.listAllTransactions({
    limit: REWRITE_ROWS,
    columns: ['id', 'payee_raw', 'direction', 'type'],
  })

  const retyped = []
  const kept = []
  for (const r of rows) {
    if (!wanted.has(r.payee_raw)) continue
    if (r.direction === 'debit' && (r.type === 'expense' || r.type === 'transfer')) retyped.push(r.id)
    else kept.push(r.id)
  }

  await backend.updateTransactions(retyped, { category, payee_clean, type, needs_review: false })
  await backend.updateTransactions(kept, { category, payee_clean, needs_review: false })
  return retyped.length + kept.length
}

export const recategoriseMerchant = (payee_raw, patch) => recategoriseRaws([payee_raw], patch)

/**
 * The same job, keyed by the merchant map's own key.
 *
 * merchant_map stores `payee_pattern` — normalised: upper-cased, punctuation
 * stripped, trailing terminal ids removed. Transactions store `payee_raw`,
 * which is whatever the OCR read. Correcting a mapping in "What it has learned"
 * was passing the pattern straight into an `eq('payee_raw', …)`, so it matched
 * nothing at all except where the raw name happened to already be upper-case
 * and punctuation-free. The toast said "past payments included" and no past
 * payment had been touched.
 *
 * No database can run normalise(), so the mapping is done here.
 */
export async function recategoriseByPattern(payee_pattern, patch) {
  const rows = await (await db()).listAllTransactions({
    limit: REWRITE_ROWS,
    columns: ['payee_raw'],
  })
  const raws = [...new Set(rows.map((r) => r.payee_raw).filter(Boolean))].filter(
    (raw) => normalise(raw) === payee_pattern,
  )
  return recategoriseRaws(raws, patch)
}
