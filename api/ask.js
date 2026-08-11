// Vercel serverless function. Turns a question into a *filter*, never an answer.
//
// GUARD: this endpoint receives the question, the category names, the payment
// method names and today's date. It never receives a transaction — no amount,
// no merchant, no date of anything you actually paid. The filter it returns is
// executed on the device against rows that never left it. If you ever find
// yourself posting rows here so the model can "just answer it", stop: that
// hands your entire ledger to a third party and breaks the one promise the app
// makes. The whole design exists to avoid that.

import { requireUser } from './_auth.js'

const MODEL = process.env.GEMINI_MODEL || 'gemini-flash-lite-latest'

const ISO = /^\d{4}-\d{2}-\d{2}$/

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null)

/** Bounded list of short strings, or the fallback. */
function list(v, max, fallback) {
  if (!Array.isArray(v)) return fallback
  const clean = v.filter((x) => typeof x === 'string' && x.length > 0 && x.length <= 40).slice(0, max)
  return clean.length > 0 ? clean : fallback
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()
  if (!(await requireUser(req, res))) return

  const question = str(req.body?.question, 300)
  if (!question || question.trim().length < 2) {
    return res.status(400).json({ error: 'send a question' })
  }

  // The client sends its own local date (Ask.jsx). The fallback is UTC, which
  // is a day behind for an IST user between midnight and 05:30 — good enough
  // for a prompt that is only ever reached when the client field is missing,
  // but never a substitute for the real one.
  const today = ISO.test(req.body?.today ?? '') ? req.body.today : new Date().toISOString().slice(0, 10)
  const categories = list(req.body?.categories, 40, ['Other'])
  const methods = list(req.body?.methods, 20, [])

  if (!process.env.GEMINI_API_KEY) {
    console.error('[ask] GEMINI_API_KEY is not set')
    return res.status(200).json({ spec: null }) // fail soft — the client falls back locally
  }

  const prompt = `You turn a question about someone's personal spending into a JSON filter.
You never see their transactions and you never answer the question yourself.

Today is ${today}. Their week starts Monday. Currency is INR.
Categories available: ${categories.join(', ')}
Payment methods available: ${methods.length ? methods.join(', ') : '(none recorded)'}

Return ONLY this JSON object, no markdown fences, no commentary:
{
  "from": "YYYY-MM-DD or null",
  "to": "YYYY-MM-DD or null",
  "categories": [],
  "types": [],
  "methods": [],
  "merchant": "substring to match, or null",
  "minAmount": null,
  "maxAmount": null,
  "groupBy": "category | merchant | method | day | null",
  "sort": "amount | date",
  "answer": "one short sentence restating what is being shown"
}

Rules:
- Only use category names from the list above, spelled exactly. Empty array means all.
- "types" may only contain: expense, income, transfer, refund, lent, repaid.
  Spending questions use ["expense"]. Money-received questions use ["income","refund","repaid"].
  Questions about a specific merchant or "all transactions" use [].
- Only use method names from the list above. These are the apps or rails a payment
  went through (gpay, phonepe, paytm, cash, UPI, NEFT...).
- If no period is stated, leave from and to null — that means all of time.
- groupBy "method" answers "which app did I pay with". groupBy "merchant" answers
  "who did I pay most". groupBy "category" answers "where did it go". groupBy "day"
  answers "which day". Use null when a single total answers the question.
- sort "amount" for biggest/most/largest, "date" otherwise.
- "answer" must describe the filter, never invent a figure. No rupee amounts in it.

Question: ${JSON.stringify(question)}`

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
    if (!r.ok || data?.error) {
      console.error(`[ask] ${MODEL} returned ${r.status}:`, data?.error?.message ?? data)
      return res.status(200).json({ spec: null })
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? 'null'
    const spec = JSON.parse(text.replace(/```json|```/g, '').trim())
    // The filter fields are deliberately returned raw: the client snaps every
    // one of them to values it already knows about before anything touches the
    // data — see lib/query.js. `answer` is the exception, because it is free
    // text that gets rendered. Capping it here stops the endpoint being usable
    // as a general-purpose text generator even by a signed-in caller.
    if (spec && typeof spec === 'object') {
      spec.answer = typeof spec.answer === 'string' ? spec.answer.slice(0, 160) : ''
    }
    return res.status(200).json({ spec })
  } catch (e) {
    console.error('[ask]', e?.message ?? e)
    return res.status(200).json({ spec: null })
  }
}
