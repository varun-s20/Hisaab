// The approval routes, driven against a stubbed fetch.
//
// The assertion that earns this file is `mutating()`: opening an Approve link
// must create nothing, mail nobody and change no row. Mail clients, antivirus
// proxies and link scanners fetch URLs out of inboxes unprompted, so the day
// that GET starts deciding is the day everyone who asks gets approved by a
// robot — and it would look like nothing was wrong.
//
//   node scripts/test-access.mjs

import assert from 'node:assert/strict'
import { handleAccess, replyTag } from '../worker/access.js'
import { sign } from '../worker/lib/token.js'

const env = {
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  APPROVE_SECRET: 'sec',
  ADMIN_EMAIL: 'admin@example.com',
  RESEND_API_KEY: 're_x',
  MAIL_FROM: 'Hisaab <no@reply.example>',
  SITE_URL: 'https://hisaab.example',
}

const ROW = {
  // A real uuid, because it has to survive a round trip through the reply
  // address and back out of the To header of the admin's reply.
  id: '11111111-2222-4333-8444-555555555555',
  email: 'asker@example.com',
  status: 'pending',
  created_at: '2026-08-13T10:00:00.000Z',
  notified_at: null,
}

let calls = []
let mails = []

globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET'
  const path = String(url).replace(env.SUPABASE_URL, '')
  calls.push(`${method} ${path}`)
  const j = (v) =>
    new Response(JSON.stringify(v), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })

  if (path.includes('api.resend.com')) {
    mails.push(JSON.parse(init.body))
    return j({ id: 'mail-1' })
  }
  if (path.includes('/auth/v1/admin/users')) return j({ id: 'user-1' })
  if (path.includes('/auth/v1/admin/generate_link'))
    return j({
      properties: {
        action_link: 'https://proj.supabase.co/auth/v1/verify?token=zzz',
      },
    })
  if (path.includes('/rest/v1/access_requests')) {
    if (method === 'POST') return j([ROW]) // the upsert, returning the row
    if (method === 'PATCH') return j([])
    if (path.includes('notified_at=gte.')) return j([]) // hourly cap has room
    return j([ROW])
  }
  throw new Error('unexpected fetch: ' + url)
}

const run = (request) => handleAccess(request, env, new URL(request.url))
const mutating = () => calls.filter((c) => /^(POST|PATCH|PUT|DELETE)/.test(c))
const asked = (fragment) => calls.some((c) => c.includes(fragment))

let passed = 0
async function check(label, fn) {
  calls = []
  mails = []
  await fn()
  passed++
  console.log('  ok  ', label)
}

const decideForm = (t, d) => {
  const f = new FormData()
  f.set('t', t)
  f.set('d', d)
  return new Request('https://hisaab.example/api/access-decide', {
    method: 'POST',
    body: f,
  })
}

const ask = (email) =>
  new Request('https://hisaab.example/api/access-request', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email }),
  })

await check('an ask records the row and mails the admin', async () => {
  // Mixed case and a trailing space, as typed on a phone.
  const r = await run(ask('Asker@Example.com '))
  assert.equal(r.status, 200)
  assert.deepEqual(await r.json(), { ok: true })
  assert.ok(asked('api.resend.com'), 'admin should have been mailed')
  assert.ok(asked('PATCH'), 'notified_at should have been stamped')
})

await check('…and it comes back on an address that names the request', async () => {
  await run(ask('asker@example.com'))
  const [note] = mails

  // The whole no-browser path hangs off this one header: reply-to is what
  // carries the row id into worker/inbound.js. If it ever goes back to being
  // the applicant's address, replies stop deciding and nothing looks broken —
  // the mail still arrives, it just goes to the wrong person.
  assert.equal(replyTag(note.reply_to), ROW.id, 'a reply must be able to find the row again')
  assert.match(note.html, /Reply <b>approve<\/b>/, 'and the mail must say to reply')
})

await check('a malformed address is refused without touching anything', async () => {
  const r = await run(ask('not-an-email'))
  assert.equal(r.status, 400)
  assert.deepEqual(calls, [])
})

await check('a missing mail secret loses the notification, not the request', async () => {
  const deaf = { ...env, ADMIN_EMAIL: '' }
  const r = await handleAccess(
    ask('asker@example.com'),
    deaf,
    new URL('https://hisaab.example/api/access-request'),
  )
  assert.equal(r.status, 200)
  assert.ok(asked('POST /rest/v1/access_requests'), 'the row must still be written')
  assert.ok(!asked('api.resend.com'), 'nothing to send it with')
})

const approveToken = await sign({ id: ROW.id, d: 'approve' }, env.APPROVE_SECRET, 3600)

await check('opening the Approve link mutates NOTHING by itself', async () => {
  const r = await run(
    new Request(`https://hisaab.example/api/access-decide?t=${encodeURIComponent(approveToken)}`),
  )
  const page = await r.text()
  assert.equal(r.status, 200)
  assert.ok(page.includes('asker@example.com'), 'the page should name the address')

  // THE assertion. A link scanner or mail client fetching this URL unattended
  // pulls the HTML and does not run it, so nothing may have happened yet. The
  // day someone "simplifies" this by deciding in the GET, everyone who applies
  // gets approved by a robot and nothing looks broken.
  assert.deepEqual(mutating(), [], `a GET mutated something: ${mutating()}`)

  // …and the decision is carried by a script the page runs on load, so the
  // admin taps once in the mail and presses nothing here.
  assert.match(page, /<form id="go" method="post"/, 'the self-submitting form')
  assert.match(page, /name="d" value="approve"/, 'carrying the decision')
  assert.match(page, /getElementById\('go'\)\.submit\(\)/, 'submitted on load')

  // The script is nonce-allowed, not 'unsafe-inline' — it is the thing that
  // decides, so it is named exactly rather than the page trusting any script.
  const nonce = /<script nonce="([a-f0-9]+)">/.exec(page)?.[1]
  assert.ok(nonce, 'the inline script must carry a nonce')
  assert.ok(
    (r.headers.get('content-security-policy') ?? '').includes(`'nonce-${nonce}'`),
    'and the CSP must be the one that allows it',
  )

  // The URL holds a live token, so this page must never be stored.
  assert.match(r.headers.get('cache-control') ?? '', /no-store/)
  assert.equal(r.headers.get('x-frame-options'), 'DENY')
})

await check('with scripting off there is still a button to press', async () => {
  const r = await run(
    new Request(`https://hisaab.example/api/access-decide?t=${encodeURIComponent(approveToken)}`),
  )
  const page = await r.text()
  assert.match(page, /<noscript>[\s\S]*<button[\s\S]*<\/noscript>/, 'a no-JS fallback')
  assert.deepEqual(mutating(), [])
})

await check('a tampered link is a dead end that mutates nothing', async () => {
  const r = await run(new Request('https://hisaab.example/api/access-decide?t=garbage.garbage'))
  assert.ok((await r.text()).includes('Nothing to do here'))
  assert.deepEqual(mutating(), [])
})

await check('the button creates the account, mints a link and mails them', async () => {
  const page = await (await run(decideForm(approveToken, 'approve'))).text()
  assert.ok(page.includes('Approved.'), page.slice(0, 300))
  assert.ok(asked('/auth/v1/admin/users'), 'the account should have been created')
  assert.ok(asked('generate_link'), 'a magic link should have been minted')
  assert.ok(asked('api.resend.com'), 'they should have been mailed')
  assert.ok(asked('PATCH'), 'the row should have been marked')
})

await check('a spent token cannot be replayed', async () => {
  ROW.status = 'approved' // as the PATCH above would have left it
  const page = await (await run(decideForm(approveToken, 'approve'))).text()
  assert.ok(page.includes('already approved'))
  assert.deepEqual(mutating(), [], 'a replayed token re-ran something')
  ROW.status = 'pending'
})

await check('without SITE_URL the row is recorded and nothing is mailed', async () => {
  // The mail carries Approve / Reject links. With no SITE_URL to build them
  // from, the base would fall back to the origin of the request that triggered
  // the send — a Host header, chosen by whoever made the request — and the
  // admin would be sent a link to somebody else's server with a live token on
  // the end of it. Recording the ask is still right; mailing about it is not.
  const bare = { ...env, SITE_URL: '' }
  const request = ask('asker@example.com')
  const r = await handleAccess(request, bare, new URL(request.url))
  assert.equal(r.status, 200)
  assert.ok(asked('access_requests'), 'the request itself must still be written down')
  assert.equal(mails.length, 0, 'no mail may be built from a Host header')
})

await check('reject declines, mails, and creates no account', async () => {
  const t = await sign({ id: ROW.id, d: 'reject' }, env.APPROVE_SECRET, 3600)
  const page = await (await run(decideForm(t, 'reject'))).text()
  assert.ok(page.includes('Rejected.'))
  assert.ok(!asked('/auth/v1/admin/users'), 'reject must not create an account')
  assert.ok(asked('api.resend.com'), 'the decline mail should have gone')
})

console.log(`\n${passed} checks passed`)
