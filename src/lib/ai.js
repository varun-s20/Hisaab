import { postJson } from './api.js'
import { currentUserId } from './auth.js'
import {
  allowedCategories, askPrompt, askToday, callGemini, categorisePrompt, merchantsProblem,
  parseCategorised, parseSpec,
} from '../../shared/gemini.js'

// Two ways to reach Gemini, one set of prompts.
//
//   no key set   the request goes to Hisaab's /api/*, spends Hisaab's quota,
//                and is counted against the caller's day (api/_auth.js)
//   key set      the browser calls Google directly and nothing about the
//                question or the merchant names touches Hisaab's servers
//
// Which backend the ledger lives in has nothing to do with this. The strings
// that reach the model — unrecognised merchant names, and the names of your own
// categories, methods and accounts — are the same strings whether the rows are
// in Hisaab's Postgres, yours, or IndexedDB on the phone. Gating the AI by
// storage would have denied a feature without protecting anything.
//
// Everything here fails soft. An unrecognised merchant stays uncategorised and
// is picked up in the weekly cleanup; Ask falls back to its local parser. A
// save is never blocked on the AI.

/** Stored per signed-in user, so a shared phone does not spend one person's
 *  key on another person's questions. Same reasoning as lib/backend.js. */
const keyFor = (userId) => `hisaab.gemini.${userId}`

export function readKey(userId) {
  if (!userId) return null
  try {
    return localStorage.getItem(keyFor(userId)) || null
  } catch {
    return null
  }
}

export function writeKey(userId, key) {
  if (!userId) throw new Error('Sign in first.')
  const clean = String(key ?? '').trim()
  if (!clean) return localStorage.removeItem(keyFor(userId))
  localStorage.setItem(keyFor(userId), clean)
}

/**
 * A Google AI Studio key looks like AIza followed by 35 more characters. Only a
 * shape check — the real test is whether Google accepts it, and the settings
 * screen runs one live rather than guessing.
 */
export function keyProblem(key) {
  const clean = String(key ?? '').trim()
  if (!clean) return null // clearing it is allowed
  if (!/^AIza[\w-]{20,}$/.test(clean)) {
    return 'That does not look like a Google AI Studio key. They begin with AIza.'
  }
  return null
}

// The key is held in memory for the length of a session so every call does not
// hit localStorage. Cleared with everything else when the user changes.
let cached = { userId: null, key: null }

export function forgetKey() {
  cached = { userId: null, key: null }
}

/** Resolved here rather than threaded through every caller, so a screen that
 *  wants a category suggestion does not have to know an account exists. */
async function keyOf() {
  const userId = await currentUserId()
  if (cached.userId !== userId) cached = { userId, key: readKey(userId) }
  return cached.key
}

export const usingOwnKey = async () => Boolean(await keyOf())

// ── The two things the app asks a model ────────────────────────────────────

export async function categoriseMerchants(merchants, categories) {
  if (merchantsProblem(merchants)) return []

  const key = await keyOf()
  if (!key) {
    const body = await postJson('/api/categorise', { merchants: merchants.slice(0, 50), categories })
    return Array.isArray(body?.results) ? body.results : []
  }

  const allowed = allowedCategories(categories)
  const parsed = await callGemini({
    apiKey: key,
    prompt: categorisePrompt(merchants.slice(0, 50), allowed),
    label: 'categorise',
  })
  // Snapped to the allowed list here exactly as the server does it — the guard
  // against a merchant's own display name carrying an instruction has to hold
  // on whichever path the call took.
  return parsed ? parseCategorised(parsed, allowed) : []
}

export async function askForFilter(body) {
  const key = await keyOf()
  if (!key) {
    const answer = await postJson('/api/ask', body)
    return answer?.spec ?? null
  }

  const spec = await callGemini({
    apiKey: key,
    prompt: askPrompt({
      question: body.question,
      today: askToday(body.today),
      categories: body.categories ?? ['Other'],
      methods: body.methods ?? [],
      accounts: body.accounts ?? [],
    }),
    label: 'ask',
  })
  return parseSpec(spec)
}
