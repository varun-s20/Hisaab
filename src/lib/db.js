import { supabase } from './supabase'
import { synthRef } from './parse'
import { today } from './format'

const COLUMNS = [
  'id', 'txn_ref', 'txn_date', 'txn_time', 'amount', 'direction', 'type',
  'payee_raw', 'payee_clean', 'category', 'subcategory', 'method', 'account',
  'source', 'confidence', 'needs_review', 'note', 'created_at',
].join(', ')

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
  const needs_review = Boolean(t.needs_review) || amount == null

  return {
    txn_ref: t.txn_ref || synthRef({ ...t, amount }),
    // txn_date is NOT NULL in the schema. A row the parser couldn't date lands
    // on today, flagged — the date is the one field a person can always
    // reconstruct from the screenshot.
    txn_date: t.txn_date ?? today(),
    txn_time: t.txn_time ?? null,
    amount,
    direction: t.direction ?? 'debit',
    // An amount-less row is not yet a claim about spending.
    type: amount ? (t.type ?? 'expense') : 'transfer',
    payee_raw: t.payee_raw,
    payee_clean: t.payee_clean ?? null,
    category: t.category ?? null,
    method: t.method ?? null,
    account: t.account ?? null,
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

  const { data, error } = await supabase.from('transactions').insert(rows).select(COLUMNS)
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
  const page = (offset, size) => {
    let q = supabase.from('transactions').select(COLUMNS)
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
    const { data, error } = await page(out.length, size)
    if (error) throw error
    out.push(...(data ?? []))
    if (!data || data.length < size) break
  }
  return out
}

/** The payment rails actually present in this ledger — gpay, phonepe, cash,
 *  NEFT… Ask needs the real list so a question can name one, and so the model
 *  is never told about apps you don't use. */
export async function listMethods() {
  const { data, error } = await supabase
    .from('transactions')
    .select('method')
    .not('method', 'is', null)
    .limit(2000)
  if (error) return []
  return [...new Set((data ?? []).map((r) => r.method).filter(Boolean))].sort()
}

export async function listNeedsReview() {
  const { data, error } = await supabase
    .from('transactions')
    .select(`${COLUMNS}, raw_text`)
    .eq('needs_review', true)
    .order('txn_date', { ascending: false })
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
  const { data, error } = await supabase
    .from('transactions')
    .update(patch)
    .eq('id', id)
    .select(COLUMNS)
    .single()
  if (error) throw error
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

export async function listBudgets() {
  const { data, error } = await supabase.from('budgets').select('category, amount')
  // Throws rather than returning []. A budget screen that says "No budgets yet"
  // because the network dropped is telling the user something false about their
  // own settings; the screen knows how to show a failure.
  if (error) throw error
  return data ?? []
}

export async function setBudget(category, amount) {
  const { error } = await supabase
    .from('budgets')
    .upsert({ category, amount }, { onConflict: 'user_id,category' })
  if (error) throw error
}

export async function removeBudget(category) {
  const { error } = await supabase.from('budgets').delete().eq('category', category)
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
export async function recategoriseMerchant(payee_raw, { category, payee_clean, type }) {
  const { error } = await supabase
    .from('transactions')
    .update({ category, payee_clean, type, needs_review: false })
    .eq('payee_raw', payee_raw)
    .eq('direction', 'debit')
  if (error) throw error

  const { error: creditError } = await supabase
    .from('transactions')
    .update({ category, payee_clean, needs_review: false })
    .eq('payee_raw', payee_raw)
    .eq('direction', 'credit')
  if (creditError) throw creditError
}
