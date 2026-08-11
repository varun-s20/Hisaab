import { supabase } from './supabase'
import { isPersonal } from './parse'
import { normalise, seedLookup, TYPE_FOR_CATEGORY } from './seeds'

// The cascade, in order — stop at the first hit:
//   1. merchant map      (Supabase, cached; a correction the user made outranks all)
//   2. the app's own tag (Paytm labels every row: Food, Money Transfer, …)
//   3. seed rules        (hardcoded brands — local, so no reason to rank below 4)
//   4. personal check    (local regex — a bare name or UPI handle is a transfer)
//   5. Gemini            (one batched call, merchant strings only)
//
// Seeds sit above the personal check because plenty of brands read as people:
// "Swiggy Diners" and "Kunafa Mahal" both match a Firstname-Lastname regex.
// Ranked the other way, a ₹1,978 dinner is silently typed as a transfer and
// vanishes from every spending total.
//
// The app's own tag sits above the personal check on purpose. Half of Indian
// merchants ARE people — the chaiwala, the sabziwala, the man who fixes your
// bike. Paytm already distinguishes "Ramnarayan Ahir · Food" from
// "Rushikesh Kedar · Money Transfer", and demoting a real food payment to a
// transfer would quietly delete it from every spending total.
//
// Personal payees still never reach the API, whatever tier they resolve at.

let mapCache = null

export async function loadMerchantMap(force = false) {
  if (mapCache && !force) return mapCache
  mapCache = new Map()
  if (!supabase) return mapCache
  const { data, error } = await supabase
    .from('merchant_map')
    .select('payee_pattern, payee_clean, category, default_type, source')
  if (!error) for (const row of data ?? []) mapCache.set(row.payee_pattern, row)
  return mapCache
}

export function clearMapCache() {
  mapCache = null
}

function typeFor(category, direction) {
  // Transfers are money moving, never spending — in either direction.
  if (category === 'Transfers') return direction === 'credit' ? 'repaid' : 'transfer'
  if (direction === 'credit') {
    // Only call it income when something actually said so. An unrecognised
    // credit is usually a friend paying you back, and "income" is a much
    // stronger claim than "transfer". Both stay out of spending totals, and the
    // row is flagged for review either way — so default to the quieter one.
    return category === 'Income' ? 'income' : 'transfer'
  }
  return TYPE_FOR_CATEGORY[category] ?? 'expense'
}

/**
 * Categorise a batch of parsed transactions in place-ish (returns new objects).
 * Never throws on AI failure — unknown merchants stay uncategorised and get
 * picked up in the weekly cleanup. Never block a save on the AI.
 */
export async function categoriseBatch(txns) {
  const map = await loadMerchantMap()
  const out = []
  const unknown = new Map() // normalised → original payee_raw

  for (const t of txns) {
    const personal = isPersonal(t.payee_raw)
    const key = normalise(t.payee_raw)

    let category = null
    let payee_clean = t.payee_raw

    if (map.has(key)) {
      const hit = map.get(key)
      category = hit.category
      payee_clean = hit.payee_clean
    } else if (t.category_hint) {
      category = t.category_hint
    } else if (seedLookup(t.payee_raw)) {
      category = seedLookup(t.payee_raw)
    } else if (personal) {
      // Your friends' names stay on your phone. No lookup, no network.
      category = 'Transfers'
    } else if (key) {
      unknown.set(key, t.payee_raw)
    }

    out.push({ ...t, category, payee_clean, _key: key, _personal: personal })
  }

  // Tier 4. One request for the whole upload, never one per transaction.
  if (unknown.size > 0) {
    const results = await askAI([...unknown.values()])
    for (const r of results) {
      const key = normalise(r.merchant)
      for (const t of out) {
        if (t._key === key && !t.category) {
          t.category = r.category
          t.payee_clean = r.clean || t.payee_raw
          t._learn = true
        }
      }
    }
  }

  return out.map((t) => ({
    ...t,
    category: t.category ?? 'Other',
    type: typeFor(t.category ?? 'Other', t.direction),
    // An uncategorised merchant is worth a look even if the OCR was perfect.
    needs_review: t.needs_review || (!t.category && !t._personal),
  }))
}

async function askAI(merchants) {
  try {
    const r = await fetch('/api/categorise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ merchants: merchants.slice(0, 50) }),
    })
    if (!r.ok) return []
    const { results } = await r.json()
    return Array.isArray(results) ? results : []
  } catch {
    return [] // Fail soft. Always.
  }
}

/**
 * Remember a categorisation. User corrections always outrank AI guesses —
 * the upsert below never downgrades a `source: 'user'` row because we only
 * write `ai` rows when nothing was there (see aiLearn).
 */
export async function learn(payee_raw, { category, payee_clean, source = 'user' }) {
  if (!supabase) return
  const payee_pattern = normalise(payee_raw)
  if (!payee_pattern) return

  const existing = mapCache?.get(payee_pattern)
  if (existing && existing.source === 'user' && source === 'ai') return

  const row = {
    payee_pattern,
    payee_clean: payee_clean || payee_raw,
    category,
    default_type: TYPE_FOR_CATEGORY[category] ?? 'expense',
    source,
    hit_count: (existing?.hit_count ?? 0) + 1,
  }
  const { data } = await supabase
    .from('merchant_map')
    .upsert(row, { onConflict: 'user_id,payee_pattern' })
    .select()
    .maybeSingle()
  if (data) mapCache?.set(payee_pattern, data)
}

/** Persist whatever the AI figured out this batch, so it never asks twice. */
export async function persistAILearnings(txns) {
  const seen = new Set()
  for (const t of txns) {
    if (!t._learn || seen.has(t._key)) continue
    seen.add(t._key)
    await learn(t.payee_raw, {
      category: t.category,
      payee_clean: t.payee_clean,
      source: 'ai',
    })
  }
}
