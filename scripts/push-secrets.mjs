// Read .env.local, hand every secret the Worker needs to Cloudflare.
//
//   npm run push-secrets          push everything that has a value
//   npm run push-secrets -- --dry show what would go, and stop
//
// Why a script rather than nine `wrangler secret put` prompts: nine prompts is
// eight chances to paste the wrong string into the wrong name, and the two
// Supabase values have to be renamed on the way (the app reads VITE_SUPABASE_*,
// the Worker wants them unprefixed).
//
// SECURITY: values are written to wrangler's STDIN, never passed as arguments.
// An argument would be visible to every other process on the machine while it
// ran, and would land in your shell history. Nothing here prints a value —
// only its name and length.

import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'

// Both files, .env.local winning, because Vite reads both and having two is a
// standing invitation to edit one and push the other. One reader, one
// precedence, printed on every run so you can see which file a value came from.
const ENV_FILES = [
  new URL('../.env', import.meta.url),
  new URL('../.env.local', import.meta.url),
]
// Generated values are written back here — the one git will never see.
const ENV_FILE = ENV_FILES[1]
const DRY = process.argv.includes('--dry')

/**
 * A .env parse that is deliberately dumb: first `=` splits, the rest is the
 * value verbatim. MAIL_FROM is `Hisaab <hello@…>` — it contains no quotes and
 * must not gain any, so quote-stripping is limited to a wrapping pair.
 */
function readEnv() {
  const out = {}
  const seen = []
  for (const file of ENV_FILES) {
    let text
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      continue // either file may be absent; only both missing is a problem
    }
    seen.push(file.pathname.split('/').pop())
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=(.*)$/.exec(line)
      if (!m) continue // comments and blanks
      let v = m[2].trim()
      if (v.length > 1 && ((v[0] === '"' && v.endsWith('"')) || (v[0] === "'" && v.endsWith("'")))) {
        v = v.slice(1, -1)
      }
      // An empty assignment is a placeholder waiting to be filled, not a value
      // that should shadow a real one set in the other file.
      if (v) out[m[1]] = { value: v, from: seen[seen.length - 1] }
    }
  }
  if (seen.length === 0) {
    console.error('No .env or .env.local. Copy .env.local.example to .env.local first.')
    process.exit(1)
  }
  console.log(`Read ${seen.join(' then ')}${seen.length > 1 ? ' (.env.local wins)' : ''}\n`)
  return out
}

/** The Worker's name for each value, and where to find it in .env.local. */
const WANTED = [
  ['GEMINI_API_KEY', ['GEMINI_API_KEY']],
  ['SUPABASE_URL', ['SUPABASE_URL', 'VITE_SUPABASE_URL']],
  ['SUPABASE_ANON_KEY', ['SUPABASE_ANON_KEY', 'VITE_SUPABASE_ANON_KEY']],
  ['SUPABASE_SERVICE_ROLE_KEY', ['SUPABASE_SERVICE_ROLE_KEY']],
  ['APPROVE_SECRET', ['APPROVE_SECRET']],
  ['RESEND_API_KEY', ['RESEND_API_KEY']],
  ['RESEND_WEBHOOK_SECRET', ['RESEND_WEBHOOK_SECRET']],
  ['MAIL_FROM', ['MAIL_FROM']],
  ['ADMIN_EMAIL', ['ADMIN_EMAIL']],
  ['SITE_URL', ['SITE_URL']],
]

/** Catch the mistakes that are silent in production and obvious here. */
function complain(name, value) {
  if (name === 'SITE_URL') {
    if (!/^https:\/\//.test(value)) return 'must start with https://'
    if (value.endsWith('/')) return 'must not end with a slash'
  }
  if (name === 'MAIL_FROM' && !/@/.test(value)) return 'needs an address, e.g. Hisaab <a@b.com>'
  if (name === 'ADMIN_EMAIL' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'not an email'
  if (name === 'RESEND_API_KEY' && !value.startsWith('re_')) return 'Resend keys start re_'
  // Easy to grab the API key twice and never notice: the webhook would reject
  // every call as unsigned, and inbound mail would vanish with no error anywhere
  // you would think to look.
  if (name === 'RESEND_WEBHOOK_SECRET' && !value.startsWith('whsec_')) {
    return 'webhook signing secrets start whsec_ — this looks like the API key'
  }
  if (name === 'APPROVE_SECRET' && value.length < 32) return 'too short — 32+ characters'
  // The one that would be catastrophic and looks fine: the anon key and the
  // service_role key are both JWTs of similar length. They differ in the role
  // claim, which is base64 in the middle segment.
  if (name === 'SUPABASE_SERVICE_ROLE_KEY' || name === 'SUPABASE_ANON_KEY') {
    const role = decodeRole(value)
    const expected = name === 'SUPABASE_ANON_KEY' ? 'anon' : 'service_role'
    if (role && role !== expected) return `this is the ${role} key, not ${expected}`
  }
  return null
}

function decodeRole(jwt) {
  try {
    const body = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString())
    return body?.role ?? null
  } catch {
    return null // not a JWT, or a new-style publishable key. Nothing to check.
  }
}

/** `wrangler secret put NAME`, value over stdin. */
const put = (name, value) =>
  new Promise((resolve) => {
    const child = spawn('npx', ['wrangler', 'secret', 'put', name], {
      stdio: ['pipe', 'inherit', 'inherit'],
      shell: process.platform === 'win32', // npx is a .cmd here
    })
    child.stdin.write(value)
    child.stdin.end()
    child.on('close', (code) => resolve(code === 0))
  })

// ── Run ──────────────────────────────────────────────────────────────────

const env = readEnv()

// A missing signing secret is not a thing to prompt about — it is a thing to
// generate correctly and never think about again.
if (!env.APPROVE_SECRET) {
  const generated = randomBytes(48).toString('base64')
  const text = readFileSync(ENV_FILE, 'utf8')
  writeFileSync(
    ENV_FILE,
    /^\s*APPROVE_SECRET\s*=.*$/m.test(text)
      ? text.replace(/^\s*APPROVE_SECRET\s*=.*$/m, `APPROVE_SECRET=${generated}`)
      : `${text.replace(/\s*$/, '')}\nAPPROVE_SECRET=${generated}\n`,
  )
  env.APPROVE_SECRET = { value: generated, from: '.env.local' }
  console.log('Generated APPROVE_SECRET (48 random bytes) and wrote it to .env.local.\n')
}

const ready = []
const missing = []
const wrong = []

for (const [name, sources] of WANTED) {
  const key = sources.find((s) => env[s])
  if (!key) {
    missing.push(name)
    continue
  }
  const { value, from } = env[key]
  const problem = complain(name, value)
  if (problem) wrong.push(`${name}: ${problem}`)
  else ready.push([name, value, key === name ? from : `${key} in ${from}`])
}

for (const [name, value, from] of ready) {
  console.log(`  ${name.padEnd(28)} ${String(value.length).padStart(4)} chars  ← ${from}`)
}
if (missing.length) console.log(`\n  not set, skipping: ${missing.join(', ')}`)
if (wrong.length) {
  console.error('\nFix these first — nothing was pushed:')
  for (const w of wrong) console.error(`  ✗ ${w}`)
  process.exit(1)
}

if (DRY) {
  console.log('\n--dry: nothing sent.')
  process.exit(0)
}

console.log(`\nPushing ${ready.length} to Cloudflare…\n`)
let failed = 0
for (const [name, value] of ready) {
  if (!(await put(name, value))) {
    failed++
    console.error(`  ✗ ${name} failed`)
  }
}

console.log(
  failed
    ? `\n${ready.length - failed} of ${ready.length} pushed. Run again for the rest.`
    : `\nAll ${ready.length} pushed. Next: npm run build && npx wrangler deploy`,
)
process.exit(failed ? 1 : 0)
