// Serverless function. Turns a question into a *filter*, never an answer.
//
// GUARD: this endpoint receives the question, the category names, the payment
// method names and today's date. It never receives a transaction — no amount,
// no merchant, no date of anything you actually paid. The filter it returns is
// executed on the device against rows that never left it. If you ever find
// yourself posting rows here so the model can "just answer it", stop: that
// hands your entire ledger to a third party and breaks the one promise the app
// makes. The whole design exists to avoid that.
//
// The prompt and the checks on what comes back live in shared/gemini.js, so a
// user spending their own Gemini key from the browser gets the same guard.

import { requireUser, withinQuota } from './_auth.js'
import { askPrompt, askToday, callGemini, DEFAULT_MODEL, list, parseSpec, str } from '../shared/gemini.js'

// Lazy: on Cloudflare the bindings are only there once a request is in flight.
const model = () => process.env.GEMINI_MODEL || DEFAULT_MODEL

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireUser(req, res)
  if (!userId) return

  const question = str(req.body?.question, 300)
  if (!question || question.trim().length < 2) {
    return res.status(400).json({ error: 'send a question' })
  }

  if (!process.env.GEMINI_API_KEY) {
    console.error('[ask] GEMINI_API_KEY is not set')
    return res.status(200).json({ spec: null }) // fail soft — the client falls back locally
  }

  if (!(await withinQuota(userId, res))) return

  const spec = await callGemini({
    apiKey: process.env.GEMINI_API_KEY,
    model: model(),
    prompt: askPrompt({
      question,
      // The client sends its own local date (Ask.jsx). The fallback is UTC,
      // which is a day behind for an IST user between midnight and 05:30 — good
      // enough for a prompt only reached when the client field is missing, but
      // never a substitute for the real one.
      today: askToday(req.body?.today),
      categories: list(req.body?.categories, 40, ['Other']),
      methods: list(req.body?.methods, 20, []),
      // The user's own cards, banks and envelopes. Names only — still no
      // amounts, no dates, no merchants. The guard at the top is unchanged.
      accounts: list(req.body?.accounts, 30, []),
    }),
    label: 'ask',
  })

  return res.status(200).json({ spec: parseSpec(spec) })
}
