// Vercel serverless function. The only reason this exists is to keep
// GEMINI_API_KEY off the client.
//
// GUARD: this endpoint accepts merchant name strings and nothing else.
// If you ever find yourself adding amount, date, UPI ID or an image here,
// stop — that breaks the privacy guarantee the whole app is built on.

import { requireUser } from './_auth.js'

const BUILT_IN = [
  'Food & Dining', 'Groceries', 'Transport', 'Shopping', 'Bills & Utilities',
  'Rent', 'Health', 'Entertainment', 'Education', 'Personal Care',
  'Household Help', 'Transfers', 'Income', 'Other',
]

/**
 * The client may send its own list, because categories the user invented live
 * in their browser and this function has no way to know them. Still bounded and
 * still snapped to the returned list afterwards — a caller cannot use this to
 * turn the endpoint into a general-purpose prompt.
 */
function allowed(body) {
  const sent = body?.categories
  if (!Array.isArray(sent) || sent.length === 0 || sent.length > 40) return BUILT_IN
  const clean = sent.filter((c) => typeof c === 'string' && c.length > 0 && c.length <= 28)
  // 'Other' is the fallback every result snaps to, so it has to be in the list.
  return clean.length > 0 ? [...new Set([...clean, 'Other'])] : BUILT_IN
}

// An alias, not a pinned version, on purpose: gemini-2.5-flash was retired for
// new keys mid-build and every call 404'd. Drift is harmless here because the
// model's category is snapped to CATEGORIES below regardless of what it says.
// Pin it with GEMINI_MODEL if a specific version ever matters.
// `node scripts/list-models.mjs` shows what this key can actually call.
const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest'

/** A merchant name, and nothing that could read as an instruction. */
function cleanName(v) {
  if (typeof v !== 'string') return 'Local merchant'
  const s = v
    .replace(/[^\p{L}\p{N} &.'-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60)
  return s || 'Local merchant'
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()
  if (!(await requireUser(req, res))) return

  const merchants = req.body?.merchants
  if (!Array.isArray(merchants) || merchants.length === 0 || merchants.length > 50) {
    return res.status(400).json({ error: 'send 1-50 merchant strings' })
  }
  if (!merchants.every((m) => typeof m === 'string' && m.length <= 120)) {
    return res.status(400).json({ error: 'merchants must be short strings' })
  }
  if (!process.env.GEMINI_API_KEY) {
    console.error('[categorise] GEMINI_API_KEY is not set')
    return res.status(200).json({ results: [] }) // fail soft, not loud
  }

  const CATEGORIES = allowed(req.body)

  const prompt = `You classify Indian merchant name strings from UPI payments into categories.

Categories: ${CATEGORIES.join(', ')}

Rules:
- Return ONLY a JSON array, no markdown fences, no commentary.
- One object per input, same order: {"merchant": <input>, "clean": <readable name>, "category": <one of the categories>}
- If the string is a payment gateway code with no recognisable brand (BHARATPE..., PAYTM-QR-...), use clean:"Local merchant" and category:"Other".
- If it looks like a person's name, category must be "Transfers".
- Never invent a brand that isn't clearly present in the string.

Input: ${JSON.stringify(merchants)}`

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`

  try {
    const controller = new AbortController()
    // Under Vercel's 10s function cap, so the abort fires and the soft-fail
    // below actually runs. A platform kill would return a 504 the client can
    // only read as "broken".
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
    // client can't tell them apart from an empty array.
    if (!r.ok || data?.error) {
      console.error(`[categorise] ${MODEL} returned ${r.status}:`, data?.error?.message ?? data)
      return res.status(200).json({ results: [] })
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]'
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())

    // Never trust the model's category — snap it to the allowed list.
    //
    // `clean` can't be snapped the same way, because the whole point of it is a
    // name the app has never seen. It is still the one field an outsider can
    // steer: whoever you pay chooses their own UPI display name, that name is
    // OCR'd into the prompt, and the result is written to merchant_map for
    // every future payment to them. Strip it to the characters a merchant name
    // can plausibly contain so an instruction can't survive the round trip.
    const results = (Array.isArray(parsed) ? parsed : [])
      .filter((x) => x && typeof x.merchant === 'string')
      .map((x) => ({
        merchant: x.merchant,
        clean: cleanName(x.clean),
        category: CATEGORIES.includes(x.category) ? x.category : 'Other',
      }))

    return res.status(200).json({ results })
  } catch (e) {
    // Fail soft: unknown merchants stay uncategorised and get picked up in the
    // weekly cleanup. Never block a save on the AI.
    console.error('[categorise]', e?.message ?? e)
    return res.status(200).json({ results: [] })
  }
}
