// Which Gemini models can THIS key actually call?
// Model IDs get retired without notice — BUILD_GUIDE.md §7.3 says to check the
// live list rather than trust a blog post. This asks the API directly.
//
//   node scripts/list-models.mjs
//
// Prints model names only. Never prints the key.

import { readFileSync } from 'node:fs'

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => {
      const i = l.indexOf('=')
      return [l.slice(0, i).trim(), l.slice(i + 1).trim()]
    }),
)

const key = env.GEMINI_API_KEY
if (!key) {
  console.error('GEMINI_API_KEY not found in .env.local')
  process.exit(1)
}

const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=200`)
const data = await r.json()

if (!r.ok) {
  console.error(`${r.status}:`, data?.error?.message ?? data)
  process.exit(1)
}

const usable = (data.models ?? [])
  .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
  .map((m) => m.name.replace('models/', ''))
  .sort()

console.log(`${usable.length} model(s) support generateContent:\n`)
for (const name of usable) console.log(`  ${name}`)

// Being listed is not the same as being callable — gemini-2.5-flash appears
// here but 404s with "no longer available to new users". So probe for real.
const shortlist = usable.filter(
  (n) => /flash/.test(n) && !/image|tts|live|omni|robotics|computer-use/.test(n),
)

console.log('\nProbing the flash models with a real call:\n')
const working = []
for (const name of shortlist) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${name}:generateContent?key=${key}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Reply with the single word: ok' }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 500 },
      }),
    },
  )
  const body = await res.json()
  const reply = body?.candidates?.[0]?.content?.parts?.[0]?.text?.trim().slice(0, 20)
  if (res.ok && !body?.error) {
    working.push(name)
    console.log(`  ok    ${name.padEnd(32)} ${JSON.stringify(reply ?? '')}`)
  } else {
    console.log(`  FAIL  ${name.padEnd(32)} ${res.status} ${body?.error?.message?.slice(0, 70) ?? ''}`)
  }
}

const preferred =
  working.find((n) => /flash-lite/.test(n) && !/preview/.test(n)) ??
  working.find((n) => !/preview/.test(n)) ??
  working[0]
console.log(`\nSet GEMINI_MODEL to: ${preferred ?? '(nothing worked)'}`)
