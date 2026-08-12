import { supabase } from './supabase'
import { synthRef } from './parse'
import { normalise } from './seeds'
import { today } from './format'

const BASE = [
  'id', 'txn_ref', 'txn_date', 'txn_time', 'amount', 'direction', 'type',
  'payee_raw', 'payee_clean', 'category', 'subcategory', 'method', 'account',
  'source', 'confidence', 'needs_review', 'note', 'created_at',
]

/**
 * `to_account` only exists once db/migrate-accounts.sql has run, and every read
 * and write in this file names it.
 *
 * On a database that has not run the migration each one comes back 42703,
 * `undefined_column` — which is not one broken feature but Today, Ledger,
 * Insights, Review and every save at once. A deploy that goes out ahead of the
 * SQL would take the whole app dark, and the error a person actually sees is
 * "column transactions.to_account does not exist" on a screen that has never
 * mentioned a column.
 *
 * So: try it, and if the column is genuinely not there, drop it for the rest of
 * the session. Costs one failed request on an unmigrated database, nothing at
 * all on a migrated one, and the app keeps working — minus the balances that
 * need the column, which is the honest amount of degradation.
 */
let hasToAccount = true

const COLUMNS = () => (hasToAccount ? [...BASE, 'to_account'] : BASE).join(', ')

const MISSING_COLUMN = '42703'

/**
 * Run a PostgREST call that names `to_account`, once more without it if the
 * column turns out not to exist. `run` is handed the column list so a caller
 * can build its own select; it must return the raw `{ data, error }`.
 */
async function withToAccount(run) {
  const first = await run(COLUMNS())
  if (!first?.error || first.error.code !== MISSING_COLUMN || !hasToAccount) return first
  hasToAccount = false
  console.warn('[db] to_account is missing — run db/migrate-accounts.sql. Account balances are off until you do.')
  return run(COLUMNS())
}

/** Strip what the database cannot store yet, so a write survives too. */
const writable = (row) => {
  if (hasToAccount) return row
  const { to_account, ...rest } = row
  void to_account
  return rest
}

/**
 * numeric(12,2) tops out just under ten billion. An OCR'd account number that
 * landed in an amount slot, or a junk column in a 500-row CSV, is not a rupee
 * figure — store nothing and let the row surface in "Needs a look". Postgres
 * would otherwise raise `numeric field overflow` and reject the entire batch
 * the bad row arrived in.
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

/**
 * Insert rows, isolating a bad one instead of losing the batch with it.
 *
 * A multi-row insert is a single statement: one duplicate that slipped past the
 * pre-check below, or one row Postgres rejects for any other reason, aborts all
 * of it. Halving on a constraint error keeps the loss to the row that caused
 * it — a concurrent second upload used to take every unrelated transaction in
 * its batch down with the one row it shared.
 */
async function insertRows(rows) {
  if (rows.length === 0) return { saved: [], rejected: 0 }

  const { data, error } = await withToAccount((cols) =>
    supabase.from('transactions').insert(rows.map(writable)).select(cols),
  )
  if (!error) return { saved: data ?? [], rejected: 0 }

  // Only a row-level rejection is worth isolating. Retrying a network or auth
  // failure once per row would turn one outage into hundreds of requests.
  if (!String(error.code ?? '').startsWith('23')) throw error
  if (rows.length === 1) return { saved: [], rejected: 1 }

  const mid = rows.length >> 1
  const a = await insertRows(rows.slice(0, mid))
  const b = await insertRows(rows.slice(mid))
  return { saved: [...a.saved, ...b.saved], rejected: a.rejected + b.rejected }
}

/**
 * Insert a batch, skipping anything whose txn_ref already exists.
 *
 * Dedup is checked client-side first so we can *report* the skip count, with
 * the unique index as the backstop for races. The index is partial
 * (`where txn_ref is not null`), which Postgres can't infer from a plain
 * upsert — hence the explicit pre-check rather than `onConflict`.
 */
export async function saveTransactions(txns) {
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
  const refs = rows.map((r) => r.txn_ref)

  // Chunked: a 400-row statement puts 400 refs in a GET query string, which is
  // long enough for PostgREST to answer 414 instead of a row list.
  const seen = new Set()
  for (let i = 0; i < refs.length; i += 200) {
    const { data: existing } = await supabase
      .from('transactions')
      .select('txn_ref')
      .in('txn_ref', refs.slice(i, i + 200))
    for (const r of existing ?? []) seen.add(r.txn_ref)
  }

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

  const { saved, rejected } = await insertRows(fresh)
  forgetAccounts() // an import is how most accounts arrive
  return { saved: saved.length, duplicates, unusable, unreadable, rejected, rows: saved }
}

/**
 * PostgREST caps a response at `max-rows` — 1000 on a default Supabase project
 * — and says nothing when it does. A `.limit(3000)` was therefore not a limit
 * of 3000, it was a silent truncation at 1000 of the *oldest* rows in the
 * window, because the ordering is newest-first. Insights would then lose whole
 * months and quietly understate every total on the screen.
 *
 * Paging round it costs one extra request per 1000 rows and removes the class
 * of bug entirely. `id` is the last sort key so a page boundary can't land in
 * the middle of a tie and repeat or skip a row.
 */
const PAGE = 1000

export async function listTransactions({ from, to, limit = 500 } = {}) {
  const page = (offset, size, cols) => {
    let q = supabase.from('transactions').select(cols)
    if (from) q = q.gte('txn_date', from)
    if (to) q = q.lte('txn_date', to)
    return q
      .order('txn_date', { ascending: false })
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .range(offset, offset + size - 1)
  }

  const out = []
  while (out.length < limit) {
    const size = Math.min(PAGE, limit - out.length)
    const { data, error } = await withToAccount((cols) => page(out.length, size, cols))
    if (error) throw error
    out.push(...(data ?? []))
    if (!data || data.length < size) break
  }
  return out
}

/** The payment rails actually present in this ledger — gpay, phonepe, cash,
 *  NEFT, or a card you named yourself. Ask needs the real list so a question
 *  can name one, and so the model is never told about apps you don't use. */
let methodCache = null

export async function listMethods() {
  if (methodCache) return methodCache
  const { data, error } = await supabase
    .from('transactions')
    .select('method')
    .not('method', 'is', null)
    .limit(2000)
  if (error) return []
  methodCache = [...new Set((data ?? []).map((r) => r.method).filter(Boolean))].sort()
  return methodCache
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
 * Cached because EditSheet asks on every open, and this is the same shape as
 * listMethods above including its ceiling: 2000 rows over the wire to find ten
 * strings. A `select distinct` RPC if either ever bites.
 */
let accountCache = null

export async function listAccounts() {
  if (accountCache) return accountCache
  // Degrades rather than throws: EditSheet asks for this, and an unmigrated
  // database must not make editing a row impossible. One column instead of two,
  // and the picker still works.
  const { data, error } = hasToAccount
    ? await supabase
        .from('transactions')
        .select('account, to_account')
        .or('account.not.is.null,to_account.not.is.null')
        .limit(2000)
    : await supabase.from('transactions').select('account').not('account', 'is', null).limit(2000)
  if (error?.code === MISSING_COLUMN) {
    hasToAccount = false
    return listAccounts()
  }
  if (error) return []
  // Both sides. An envelope you have only ever funded — money in, nothing spent
  // yet — is still an account, and reading `account` alone made it invisible
  // until the first time you paid from it.
  const seen = new Set()
  for (const r of data ?? []) {
    if (r.account) seen.add(r.account)
    if (r.to_account) seen.add(r.to_account)
  }
  accountCache = [...seen].sort()
  return accountCache
}

/**
 * What is left in each account: everything that arrived, minus everything that
 * left. The number an envelope budgeter checks daily and the app could not
 * answer.
 *
 *   in   transfers whose to_account is this one, and credits landing in it
 *   out  every debit from it, spending and transfers out alike
 *
 * A `transfer` counts on both sides here and in no spending total anywhere
 * else, which is the point of the type: moving your own money changes where it
 * is without changing how much of it there is.
 *
 * ponytail: summed on the device over the narrowest possible select. An
 * aggregate would need a Postgres function and a migration to go with it; this
 * is five columns and stays correct while a ledger is small enough to hold.
 * The 5000 ceiling is stated in the caller — Budgets says so on screen.
 */
export const BALANCE_ROWS = 5000

export async function accountBalances() {
  if (!hasToAccount) throw new Error('Run db/migrate-accounts.sql — this screen needs the to_account column.')
  const { data, error } = await supabase
    .from('transactions')
    .select('account, to_account, amount, direction, type')
    .or('account.not.is.null,to_account.not.is.null')
    .limit(BALANCE_ROWS)
  if (error?.code === MISSING_COLUMN) {
    hasToAccount = false
    throw new Error('Run db/migrate-accounts.sql — this screen needs the to_account column.')
  }
  if (error) throw error

  const acc = new Map()
  const at = (name) => {
    if (!acc.has(name)) acc.set(name, { account: name, in: 0, out: 0, count: 0 })
    return acc.get(name)
  }

  for (const r of data ?? []) {
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
 */
export async function mergeAccount(from, to) {
  const target = to?.trim() || null
  if (!from || from === target) return 0
  for (const column of hasToAccount ? ['account', 'to_account'] : ['account']) {
    const { error } = await supabase
      .from('transactions')
      .update({ [column]: target })
      .eq(column, from)
    if (error) throw error
  }
  // A cap set on the old name would otherwise sit there capping nothing.
  // Untouched on an unmigrated database, where an account cap cannot exist.
  if (hasScope) {
    await supabase.from('budgets').delete().eq('scope', 'account').eq('category', from)
  }
  forgetAccounts()
  return 1
}

/** Both lists are read off the rows, so both go stale the moment a row is
 *  written. saveTransactions and updateTransaction are the only two writers. */
const forgetAccounts = () => {
  accountCache = null
  methodCache = null
}

/**
 * The same wipe, for a change of user rather than a change of row.
 *
 * These caches are somebody's bank, card and envelope names, held in a module
 * variable that survives a sign-out — the tab is never reloaded, App.jsx just
 * swaps the screen. Signing in as someone else therefore showed the previous
 * person's accounts in every picker, and Ask sent them to the model as the new
 * person's (src/screens/Ask.jsx passes listAccounts() straight to /api/ask).
 */
export const forgetCaches = forgetAccounts

export async function listNeedsReview() {
  const { data, error } = await withToAccount((cols) =>
    supabase
      .from('transactions')
      .select(`${cols}, raw_text`)
      .eq('needs_review', true)
      .order('txn_date', { ascending: false }),
  )
  if (error) throw error
  return data ?? []
}

export async function countNeedsReview() {
  const { count, error } = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .eq('needs_review', true)
  if (error) return 0
  return count ?? 0
}

export async function updateTransaction(id, patch) {
  const { data, error } = await withToAccount((cols) =>
    supabase.from('transactions').update(writable(patch)).eq('id', id).select(cols).single(),
  )
  if (error) throw error
  if ('account' in patch || 'method' in patch) forgetAccounts()
  return data
}

export async function deleteTransaction(id) {
  const { error } = await supabase.from('transactions').delete().eq('id', id)
  if (error) throw error
}

/** Undo an import. Deleting by the ids the insert handed back is exact — a
 *  date range would also take rows that were already there. */
export async function deleteTransactions(ids) {
  if (!ids?.length) return 0
  const { error } = await supabase.from('transactions').delete().in('id', ids)
  if (error) throw error
  return ids.length
}

// ── Budgets ────────────────────────────────────────────────────────────────
// Category '*' is the cap for the whole month. See db/schema.sql.
export const TOTAL_BUDGET = '*'

// `scope` says whether the `category` column is naming a category or an
// account. Envelope budgeting caps the pocket rather than the kind of spending:
// "₹7,500 into Wants this month" is the decision people actually make, and
// which categories it lands on is the consequence. Defaulted everywhere so
// every existing call still means what it did.
/**
 * Same migration problem as `to_account`, on a screen that already existed:
 * without `scope` this select is a 42703 and Budgets — which worked yesterday —
 * shows a failure instead of the caps someone already set. Fall back to the old
 * shape and call everything a category budget, which is exactly what every row
 * in an unmigrated table is.
 */
let hasScope = true

export async function listBudgets() {
  const { data, error } = hasScope
    ? await supabase.from('budgets').select('scope, category, amount')
    : await supabase.from('budgets').select('category, amount')
  if (error?.code === MISSING_COLUMN) {
    hasScope = false
    return listBudgets()
  }
  // Throws rather than returning []. A budget screen that says "No budgets yet"
  // because the network dropped is telling the user something false about their
  // own settings; the screen knows how to show a failure.
  if (error) throw error
  return (data ?? []).map((b) => ({ ...b, scope: b.scope ?? 'category' }))
}

export async function setBudget(category, amount, scope = 'category') {
  // An account cap cannot be stored without the column, and silently writing it
  // as a category budget would cap the wrong thing under the same name.
  if (!hasScope && scope !== 'category') {
    throw new Error('Run db/migrate-accounts.sql — an account cap needs the scope column.')
  }
  const { error } = hasScope
    ? await supabase
        .from('budgets')
        .upsert({ scope, category, amount }, { onConflict: 'user_id,scope,category' })
    : await supabase.from('budgets').upsert({ category, amount }, { onConflict: 'user_id,category' })
  if (error?.code === MISSING_COLUMN) {
    hasScope = false
    return setBudget(category, amount, scope)
  }
  if (error) throw error
}

export async function removeBudget(category, scope = 'category') {
  let q = supabase.from('budgets').delete().eq('category', category)
  if (hasScope) q = q.eq('scope', scope)
  const { error } = await q
  if (error?.code === MISSING_COLUMN) {
    hasScope = false
    return removeBudget(category, scope)
  }
  if (error) throw error
}

// ── Merchant map, as data you can see and correct ──────────────────────────
export async function listMerchantMap() {
  const { data, error } = await supabase
    .from('merchant_map')
    .select('payee_pattern, payee_clean, category, source, hit_count')
    .order('hit_count', { ascending: false })
  if (error) throw error
  return data ?? []
}

/** Forget a mapping. The transactions keep their category; the merchant simply
 *  becomes teachable again, which is the point of doing this at all. */
export async function deleteMerchantMapping(payee_pattern) {
  const { error } = await supabase.from('merchant_map').delete().eq('payee_pattern', payee_pattern)
  if (error) throw error
}

/** How many merchants are waiting in "Teach me". Same query as listUntaught —
 *  the screen was the only thing that knew there was anything to do, so nobody
 *  opened it. Cheap enough to run beside countNeedsReview on every refresh. */
export async function countUntaught() {
  try {
    return (await listUntaught(500)).length
  } catch {
    return 0
  }
}

/** Merchants seen in transactions that the map doesn't know yet. */
export async function listUntaught(limit = 25) {
  const { data, error } = await supabase
    .from('transactions')
    .select('payee_raw, category, amount, txn_date')
    .or('category.is.null,category.eq.Other')
    .neq('type', 'transfer')
    .order('txn_date', { ascending: false })
    .limit(200)
  if (error) throw error

  const groups = new Map()
  for (const r of data ?? []) {
    const g = groups.get(r.payee_raw) ?? { payee_raw: r.payee_raw, count: 0, total: 0 }
    g.count += 1
    g.total += Number(r.amount)
    groups.set(r.payee_raw, g)
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, limit)
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
 */
async function recategoriseRaws(raws, { category, payee_clean, type }) {
  if (!raws.length) return 0
  // Chunked for the same reason the dedup pre-check is: a few hundred names in
  // a query string is a 414, not a row list.
  for (let i = 0; i < raws.length; i += 100) {
    const chunk = raws.slice(i, i + 100)

    // Only rows whose type was a default get a new one. 'investment', 'lent'
    // and 'refund' are things a person sat down and said about a specific row,
    // and a later lesson about the merchant's *category* is not new information
    // about any of them — teaching "SIP" used to flatten every investment under
    // that merchant back to an expense.
    const { error } = await supabase
      .from('transactions')
      .update({ category, payee_clean, type, needs_review: false })
      .in('payee_raw', chunk)
      .eq('direction', 'debit')
      .in('type', ['expense', 'transfer'])
    if (error) throw error

    // The rest keep their type and still get the name and the category.
    const { error: keptError } = await supabase
      .from('transactions')
      .update({ category, payee_clean, needs_review: false })
      .in('payee_raw', chunk)
      .eq('direction', 'debit')
      .not('type', 'in', '("expense","transfer")')
    if (keptError) throw keptError

    const { error: creditError } = await supabase
      .from('transactions')
      .update({ category, payee_clean, needs_review: false })
      .in('payee_raw', chunk)
      .eq('direction', 'credit')
    if (creditError) throw creditError
  }
  return raws.length
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
 * Postgres cannot run normalise(), so the mapping is done here: read the names,
 * match them, then write by the names that actually matched.
 */
export async function recategoriseByPattern(payee_pattern, patch) {
  const { data, error } = await supabase.from('transactions').select('payee_raw').limit(5000)
  if (error) throw error
  const raws = [...new Set((data ?? []).map((r) => r.payee_raw).filter(Boolean))].filter(
    (raw) => normalise(raw) === payee_pattern,
  )
  return recategoriseRaws(raws, patch)
}
