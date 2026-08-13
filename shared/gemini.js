// The prompts, and everything that validates what comes back.
//
// Imported by BOTH sides: api/ask.js and api/categorise.js spend Hisaab's key
// on the server, and src/lib/ai.js spends a user's own key straight from the
// browser. Two copies of these prompts would drift, and the drift would show up
// as one group of users getting worse categorisation than the other with
// nothing to explain it.
//
// Pure: no process.env, no fetch defaults, no browser API. Both bundlers take
// it as-is.

export const DEFAULT_MODEL = 'gemini-flash-lite-latest'

export const BUILT_IN_CATEGORIES = [
  'Food & Dining', 'Groceries', 'Transport', 'Shopping', 'Bills & Utilities',
  'Rent', 'Health', 'Entertainment', 'Education', 'Personal Care',
  'Household Help', 'Transfers', 'Income', 'Other',
]

const ISO = /^\d{4}-\d{2}-\d{2}$/

export const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null)

/** Bounded list of short strings, or the fallback. */
export function list(v, max, fallback) {
  if (!Array.isArray(v)) return fallback
  const clean = v.filter((x) => typeof x === 'string' && x.length > 0 && x.length <= 40).slice(0, max)
  return clean.length > 0 ? clean : fallback
}

/**
 * The client may send its own list, because categories the user invented live
 * in their browser and the server has no way to know them. Still bounded and
 * still snapped to the returned list afterwards — a caller cannot use this to
 * turn the endpoint into a general-purpose prompt.
 */
export function allowedCategories(sent) {
  if (!Array.isArray(sent) || sent.length === 0 || sent.length > 40) return BUILT_IN_CATEGORIES
  const clean = sent.filter((c) => typeof c === 'string' && c.length > 0 && c.length <= 28)
  // 'Other' is the fallback every result snaps to, so it has to be in the list.
  return clean.length > 0 ? [...new Set([...clean, 'Other'])] : BUILT_IN_CATEGORIES
}

/** A merchant name, and nothing that could read as an instruction. */
export function cleanName(v) {
  if (typeof v !== 'string') return 'Local merchant'
  const s = v
    .replace(/[^\p{L}\p{N} &.'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return s || 'Local merchant'
}

/** True when this is 1-50 short merchant strings and nothing else. */
export function merchantsProblem(merchants) {
  if (!Array.isArray(merchants) || merchants.length === 0 || merchants.length > 50) {
    return 'send 1-50 merchant strings'
  }
  if (!merchants.every((m) => typeof m === 'string' && m.length <= 120)) {
    return 'merchants must be short strings'
  }
  return null
}

// ── Categorise ─────────────────────────────────────────────────────────────

export const categorisePrompt = (merchants, categories) =>
  `You classify Indian merchant name strings from UPI payments into categories.

Categories: ${categories.join(', ')}

Rules:
- Return ONLY a JSON array, no markdown fences, no commentary.
- One object per input, same order: {"merchant": <input>, "clean": <readable name>, "category": <one of the categories>}
- If the string is a payment gateway code with no recognisable brand (BHARATPE..., PAYTM-QR-...), use clean:"Local merchant" and category:"Other".
- If it looks like a person's name, category must be "Transfers".
- Never invent a brand that isn't clearly present in the string.

Input: ${JSON.stringify(merchants)}`

/**
 * Never trust the model's category — snap it to the allowed list.
 *
 * `clean` can't be snapped the same way, because the whole point of it is a
 * name the app has never seen. It is still the one field an outsider can steer:
 * whoever you pay chooses their own UPI display name, that name is OCR'd into
 * the prompt, and the result is written to merchant_map for every future
 * payment to them. cleanName strips it to the characters a merchant name can
 * plausibly contain so an instruction can't survive the round trip.
 */
export function parseCategorised(parsed, categories) {
  return (Array.isArray(parsed) ? parsed : [])
    .filter((x) => x && typeof x.merchant === 'string')
    .map((x) => ({
      merchant: x.merchant,
      clean: cleanName(x.clean),
      category: categories.includes(x.category) ? x.category : 'Other',
    }))
}

// ── Ask ────────────────────────────────────────────────────────────────────

export function askPrompt({ question, today, categories, methods, accounts }) {
  return `You turn a question about someone's personal spending into a JSON filter.
You never see their transactions and you never answer the question yourself.

Today is ${today}. Their week starts Monday. Currency is INR.
Categories available: ${categories.join(', ')}
Payment methods available: ${methods.length ? methods.join(', ') : '(none recorded)'}
Accounts available: ${accounts.length ? accounts.join(', ') : '(none recorded)'}

Return ONLY this JSON object, no markdown fences, no commentary:
{
  "from": "YYYY-MM-DD or null",
  "to": "YYYY-MM-DD or null",
  "categories": [],
  "types": [],
  "methods": [],
  "accounts": [],
  "merchant": "substring to match, or null",
  "minAmount": null,
  "maxAmount": null,
  "groupBy": "category | merchant | method | account | day | null",
  "sort": "amount | date",
  "answer": "one short sentence restating what is being shown"
}

Rules:
- Only use category names from the list above, spelled exactly. Empty array means all.
- "types" may only contain: expense, income, investment, transfer, refund, lent, repaid.
  Spending questions use ["expense"]. Money-received questions use ["income","refund","repaid"].
  SIP / mutual fund / "what did I invest" questions use ["investment"].
  Questions about a specific merchant, "my biggest transaction", or "all transactions" use [].
- Only use method names from the list above. These are the apps or rails a payment
  went through (gpay, phonepe, paytm, cash, UPI, NEFT...).
- Only use account names from the list above, spelled exactly. These are the cards,
  banks and envelopes the money came OUT of (HDFC card, SBI, Needs, Wants...).
  The method is how it travelled; the account is which pocket it left. A question
  naming a card or a bank or an envelope is about accounts, not methods.
- If no period is stated, leave from and to null — that means all of time.
- groupBy "method" answers "which app did I pay with". groupBy "merchant" answers
  "who did I pay most". groupBy "category" answers "where did it go". groupBy
  "account" answers "which card, bank or envelope did it come out of". groupBy
  "day" answers "which day". Use null when a single total answers the question.
- sort "amount" for biggest/most/largest, "date" otherwise.
- "answer" must describe the filter, never invent a figure. No rupee amounts in it.

Question: ${JSON.stringify(question)}`
}

export const askToday = (sent) =>
  ISO.test(sent ?? '') ? sent : new Date().toISOString().slice(0, 10)

/**
 * The filter fields are deliberately returned raw: the client snaps every one
 * of them to values it already knows about before anything touches the data —
 * see src/lib/query.js. `answer` is the exception, because it is free text that
 * gets rendered. Capping it stops this being usable as a general-purpose text
 * generator even by a signed-in caller.
 */
export function parseSpec(spec) {
  if (spec && typeof spec === 'object') {
    spec.answer = typeof spec.answer === 'string' ? spec.answer.slice(0, 160) : ''
  }
  return spec ?? null
}

// ── The call ───────────────────────────────────────────────────────────────

/**
 * One request to Gemini, returning parsed JSON or null.
 *
 * Never throws. Every caller of this fails soft by design — an unknown merchant
 * stays uncategorised and gets picked up in the weekly cleanup, and Ask falls
 * back to its local parser. Blocking a save on the AI is the one thing this
 * must never do.
 *
 * The 9s timeout sits under Vercel's 10s function cap so the abort fires and
 * the soft-fail actually runs; a platform kill would return a 504 the client
 * can only read as "broken".
 */
export async function callGemini({ apiKey, model = DEFAULT_MODEL, prompt, label = 'gemini' }) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 9000)
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json' },
      }),
      signal: controller.signal,
    })
    clearTimeout(timer)

    const data = await r.json()
    // Fail soft to the caller, but never silently to the operator — this is the
    // difference between "no key", "quota spent" and "model renamed", and the
    // caller cannot tell them apart from an empty result.
    if (!r.ok || data?.error) {
      console.error(`[${label}] ${model} returned ${r.status}:`, data?.error?.message ?? data)
      return null
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? 'null'
    return JSON.parse(text.replace(/```json|```/g, '').trim())
  } catch (e) {
    console.error(`[${label}]`, e?.message ?? e)
    return null
  }
}
