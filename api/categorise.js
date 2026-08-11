// Vercel serverless function. The only reason this exists is to keep
// GEMINI_API_KEY off the client.
//
// GUARD: this endpoint accepts merchant name strings and nothing else.
// If you ever find yourself adding amount, date, UPI ID or an image here,
// stop — that breaks the privacy guarantee the whole app is built on.

const CATEGORIES = [
  'Food & Dining', 'Groceries', 'Transport', 'Shopping', 'Bills & Utilities',
  'Rent', 'Health', 'Entertainment', 'Education', 'Personal Care',
  'Household Help', 'Transfers', 'Income', 'Other',
]

const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash'

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end()

  const merchants = req.body?.merchants
  if (!Array.isArray(merchants) || merchants.length === 0 || merchants.length > 50) {
    return res.status(400).json({ error: 'send 1-50 merchant strings' })
  }
  if (!merchants.every((m) => typeof m === 'string' && m.length <= 120)) {
    return res.status(400).json({ error: 'merchants must be short strings' })
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(200).json({ results: [] }) // fail soft, not loud
  }

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
    const timer = setTimeout(() => controller.abort(), 12000)
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
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '[]'
    const parsed = JSON.parse(text.replace(/```json|```/g, '').trim())

    // Never trust the model's category — snap it to the allowed list.
    const results = (Array.isArray(parsed) ? parsed : [])
      .filter((x) => x && typeof x.merchant === 'string')
      .map((x) => ({
        merchant: x.merchant,
        clean: typeof x.clean === 'string' ? x.clean.slice(0, 60) : 'Local merchant',
        category: CATEGORIES.includes(x.category) ? x.category : 'Other',
      }))

    return res.status(200).json({ results })
  } catch {
    // Fail soft: unknown merchants stay uncategorised and get picked up in the
    // weekly cleanup. Never block a save on the AI.
    return res.status(200).json({ results: [] })
  }
}
