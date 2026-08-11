import { supabase } from './supabase'
import { synthRef } from './parse'
import { today } from './format'

const COLUMNS = [
  'id', 'txn_ref', 'txn_date', 'txn_time', 'amount', 'direction', 'type',
  'payee_raw', 'payee_clean', 'category', 'subcategory', 'method', 'account',
  'source', 'confidence', 'needs_review', 'note', 'created_at',
].join(', ')

/** Drop the leading-underscore working fields the cascade adds. */
function forInsert(t) {
  return {
    txn_ref: t.txn_ref || synthRef(t),
    // txn_date is NOT NULL in the schema. A row the parser couldn't date lands
    // on today, flagged — the date is the one field a person can always
    // reconstruct from the screenshot.
    txn_date: t.txn_date ?? today(),
    txn_time: t.txn_time ?? null,
    amount: t.amount ?? null,
    direction: t.direction ?? 'debit',
    // An amount-less row is not yet a claim about spending.
    type: t.amount ? (t.type ?? 'expense') : 'transfer',
    payee_raw: t.payee_raw,
    payee_clean: t.payee_clean ?? null,
    category: t.category ?? null,
    method: t.method ?? null,
    account: t.account ?? null,
    source: t.source ?? 'screenshot',
    confidence: t.confidence ?? 1.0,
    needs_review: Boolean(t.needs_review),
    note: t.note ?? null,
    raw_text: t.raw_text ?? null,
  }
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
  if (usable.length === 0) return { saved: 0, duplicates: 0, unusable, unreadable: 0, rows: [] }

  const unreadable = usable.filter((t) => !t.amount).length
  const rows = usable.map(forInsert)
  const refs = rows.map((r) => r.txn_ref)

  const { data: existing } = await supabase
    .from('transactions')
    .select('txn_ref')
    .in('txn_ref', refs)
  const seen = new Set((existing ?? []).map((r) => r.txn_ref))

  // Same screenshot twice inside one upload counts as a duplicate too.
  const fresh = []
  const batchSeen = new Set()
  for (const r of rows) {
    if (seen.has(r.txn_ref) || batchSeen.has(r.txn_ref)) continue
    batchSeen.add(r.txn_ref)
    fresh.push(r)
  }
  const duplicates = rows.length - fresh.length
  if (fresh.length === 0) return { saved: 0, duplicates, unusable, unreadable: 0, rows: [] }

  const { data, error } = await supabase.from('transactions').insert(fresh).select(COLUMNS)
  if (error) throw error
  return { saved: data.length, duplicates, unusable, unreadable, rows: data }
}

export async function listTransactions({ from, to, limit = 500 } = {}) {
  let q = supabase.from('transactions').select(COLUMNS)
  if (from) q = q.gte('txn_date', from)
  if (to) q = q.lte('txn_date', to)
  const { data, error } = await q
    .order('txn_date', { ascending: false })
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return data ?? []
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

/** Apply a taught category to every existing row for that merchant. */
export async function recategoriseMerchant(payee_raw, { category, payee_clean, type }) {
  const { error } = await supabase
    .from('transactions')
    .update({ category, payee_clean, type, needs_review: false })
    .eq('payee_raw', payee_raw)
  if (error) throw error
}
