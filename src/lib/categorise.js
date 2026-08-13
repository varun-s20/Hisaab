// Extensions are explicit here, as they are in lib/db.js and lib/query.js:
// Vite resolves without them and plain node does not, and
// `node scripts/test-parse.mjs` imports this file for suggestCategory.
import { listMerchantMap, upsertMerchantMapping } from './db.js'
import { categoriseMerchants } from './ai.js'
import { allCategories } from './categories.js'
import { isPersonal } from './parse.js'
import { normalise, seedLookup, TYPE_FOR_CATEGORY } from './seeds.js'

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
  // Fails soft into an empty map. The cascade below degrades to seeds and the
  // personal check without it, which is a worse categorisation and not a broken
  // app — and this runs on every launch, including the ones where the backend
  // is a paused project or a phone that is offline.
  try {
    for (const row of await listMerchantMap()) mapCache.set(row.payee_pattern, row)
  } catch {
    // Left empty on purpose.
  }
  return mapCache
}

export function clearMapCache() {
  mapCache = null
}

/**
 * What this app already knows a payee should be filed under, or null.
 *
 * The first three tiers of the cascade above, and only those three: a map hit,
 * then the seed rules, then the personal check. Nothing here touches the
 * network, so it is cheap enough to run on every keystroke of a payee field.
 *
 * It exists because the add form did not use any of it. Typing "Swiggy" saved a
 * row as 'Other' and put it in the Teach queue — where the app then offered
 * "Food & Dining", out of a rule that was in the bundle the whole time. Work
 * the app invented for itself, on the screen where somebody is already typing.
 *
 * Returns a suggestion, never a decision. The caller fills the picker in and
 * the person can overrule it, which is the difference between help and a guess
 * written to the ledger.
 */
export function suggestCategory(payee) {
  const key = normalise(payee)
  if (!key) return null
  const hit = mapCache?.get(key)
  if (hit?.category) return hit.category
  const seed = seedLookup(payee)
  if (seed) return seed
  // A friend's name is a transfer, and that judgement is made on this device
  // and stays here — the same rule the cascade applies, at the same rank.
  return isPersonal(payee) ? 'Transfers' : null
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

// Hisaab's quota, or the user's own Gemini key if they set one — lib/ai.js
// decides. Fail soft either way: no result means the merchant stays unknown and
// turns up in "Teach me", which is a worse guess and not a broken import.
//
// The category list rides along, which it did not use to. Categories somebody
// invented live on the device and the server cannot know them, so leaving the
// argument off meant allowedCategories() fell back to the fourteen built-ins and
// parseCategorised snapped everything else to 'Other' — a category called
// "Therapy" was pickable in Teach and unreachable from a screenshot or a
// statement import, which is every row the app files on its own.
const askAI = (merchants) => categoriseMerchants(merchants, allCategories())

/**
 * Remember a categorisation. User corrections always outrank AI guesses.
 *
 * The in-memory check below is only a fast path: mapCache is loaded once per
 * session (App.jsx), so a correction made on another device is invisible to it.
 * The guarantee is `ignoreDuplicates` on the AI write — the database, not the
 * cache, is what refuses to overwrite a row that already exists.
 */
export async function learn(payee_raw, { category, payee_clean, source = 'user' }) {
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
  const saved = await upsertMerchantMapping(row, { ignoreDuplicates: source === 'ai' })
  if (saved) mapCache?.set(payee_pattern, saved)
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
