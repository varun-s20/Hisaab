// Serverless function. The only reason this exists is to keep GEMINI_API_KEY
// off the client.
//
// GUARD: this endpoint accepts merchant name strings and nothing else.
// If you ever find yourself adding amount, date, UPI ID or an image here,
// stop — that breaks the privacy guarantee the whole app is built on.
//
// The prompt and every check on what comes back live in shared/gemini.js,
// because a user running their own Gemini key calls the model straight from the
// browser and has to get exactly the same treatment. See src/lib/ai.js.

import { requireUser, withinQuota } from './_auth.js'
import {
  allowedCategories, callGemini, categorisePrompt, DEFAULT_MODEL, merchantsProblem, parseCategorised,
} from '../shared/gemini.js'

// An alias, not a pinned version, on purpose: gemini-2.5-flash was retired for
// new keys mid-build and every call 404'd. Drift is harmless here because the
// model's category is snapped to the allowed list regardless of what it says.
// Pin it with GEMINI_MODEL if a specific version ever matters.
// `node scripts/list-models.mjs` shows what this key can actually call.
// Lazy: on Cloudflare the bindings are only there once a request is in flight.
const model = () => process.env.GEMINI_MODEL || DEFAULT_MODEL

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const userId = await requireUser(req, res)
  if (!userId) return

  const merchants = req.body?.merchants
  const problem = merchantsProblem(merchants)
  if (problem) return res.status(400).json({ error: problem })

  if (!process.env.GEMINI_API_KEY) {
    console.error('[categorise] GEMINI_API_KEY is not set')
    return res.status(200).json({ results: [] }) // fail soft, not loud
  }

  // Counted after the request is known to be well-formed, so a malformed call
  // cannot burn somebody's daily allowance, and before the model is called, so
  // the thing being limited is the thing that costs money.
  if (!(await withinQuota(userId, res))) return

  const categories = allowedCategories(req.body?.categories)
  const parsed = await callGemini({
    apiKey: process.env.GEMINI_API_KEY,
    model: model(),
    prompt: categorisePrompt(merchants, categories),
    label: 'categorise',
  })

  // Fail soft: unknown merchants stay uncategorised and get picked up in the
  // weekly cleanup. Never block a save on the AI.
  return res.status(200).json({ results: parsed ? parseCategorised(parsed, categories) : [] })
}
