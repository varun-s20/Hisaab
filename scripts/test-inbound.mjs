// /api/inbound is a public URL that makes the app send mail. The Svix
// signature is the ONLY thing in front of it, so these assertions are the
// difference between a forwarder and an open relay pointed at your inbox.
//
//   node scripts/test-inbound.mjs

import assert from 'node:assert/strict'
import { handleInbound, readDecision } from '../worker/inbound.js'

const SECRET_BYTES = Buffer.from('a'.repeat(32))
const env = {
  RESEND_WEBHOOK_SECRET: `whsec_${SECRET_BYTES.toString('base64')}`,
  RESEND_API_KEY: 're_test',
  ADMIN_EMAIL: 'admin@example.com',
  MAIL_FROM: 'Hisaab <hello@example.com>',
  SUPABASE_URL: 'https://proj.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role',
  SITE_URL: 'https://hisaab.example',
}

/** The pending request an admin's reply decides. */
const REQUEST_ID = '11111111-2222-4333-8444-555555555555'
const DECIDE_TO = [`hello+${REQUEST_ID}@example.com`]
let row = { id: REQUEST_ID, email: 'asker@example.net', status: 'pending' }

let calls = []
let received = {
  id: 'em_1',
  from: 'stranger@example.net',
  to: ['hello@example.com'],
  subject: 'why was I rejected?',
  html: '<p>hello</p>',
  text: 'hello',
  attachments: [],
}

globalThis.fetch = async (url, init = {}) => {
  const method = init.method ?? 'GET'
  calls.push({ url: String(url), method, body: init.body })
  const j = (v) =>
    new Response(JSON.stringify(v), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  if (String(url).includes('/emails/receiving/')) return j(received)
  if (String(url) === 'https://api.resend.com/emails') return j({ id: 'sent_1' })
  if (String(url).includes('/rest/v1/access_requests')) return j(method === 'PATCH' ? [] : [row])
  if (String(url).includes('/auth/v1/admin/users')) return j({ id: 'user_1' })
  if (String(url).includes('/auth/v1/admin/generate_link'))
    return j({
      properties: {
        action_link: 'https://proj.supabase.co/auth/v1/verify?token=zzz',
      },
    })
  throw new Error('unexpected fetch ' + url)
}

/** Sign a body the way Svix does: HMAC-SHA256 over `{id}.{timestamp}.{body}`. */
async function sign(body, { id = 'msg_1', timestamp = Math.floor(Date.now() / 1000) } = {}) {
  const key = await crypto.subtle.importKey(
    'raw',
    SECRET_BYTES,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${id}.${timestamp}.${body}`),
  )
  return {
    id,
    timestamp: String(timestamp),
    signature: `v1,${Buffer.from(mac).toString('base64')}`,
  }
}

const post = (body, headers) =>
  handleInbound(
    new Request('https://hisaab.example/api/inbound', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(headers
          ? {
              'svix-id': headers.id,
              'svix-timestamp': headers.timestamp,
              'svix-signature': headers.signature,
            }
          : {}),
      },
      body,
    }),
    env,
  )

const EVENT = JSON.stringify({
  type: 'email.received',
  data: { email_id: 'em_1' },
})
const mails = () =>
  calls.filter((c) => c.url === 'https://api.resend.com/emails').map((c) => JSON.parse(c.body))
const forwarded = () => mails().some((m) => m.subject.startsWith('Fwd:'))
const accountMade = () => calls.some((c) => c.url.includes('/auth/v1/admin/users'))
const marked = () => calls.some((c) => c.method === 'PATCH' && c.url.includes('access_requests'))

let passed = 0
async function check(label, fn) {
  calls = []
  await fn()
  passed++
  console.log('  ok  ', label)
}

await check('a properly signed email.received is forwarded to the admin', async () => {
  const r = await post(EVENT, await sign(EVENT))
  assert.equal(r.status, 200)
  assert.ok(forwarded(), 'it should have been forwarded')
  const sent = JSON.parse(calls.find((c) => c.url === 'https://api.resend.com/emails').body)
  assert.deepEqual(sent.to, ['admin@example.com'])
  // Replying has to reach whoever wrote in, not the address that forwarded it.
  assert.equal(sent.reply_to, 'stranger@example.net')
  assert.match(sent.subject, /^Fwd: why was I rejected\?$/)
})

await check('an unsigned request forwards nothing', async () => {
  const r = await post(EVENT, null)
  assert.equal(r.status, 400)
  assert.equal(forwarded(), false)
})

await check('a body altered after signing is refused', async () => {
  const headers = await sign(EVENT)
  const tampered = JSON.stringify({
    type: 'email.received',
    data: { email_id: 'em_EVIL' },
  })
  const r = await post(tampered, headers)
  assert.equal(r.status, 400)
  assert.equal(forwarded(), false)
})

await check('a signature from a different secret is refused', async () => {
  const r = await post(EVENT, {
    id: 'msg_1',
    timestamp: String(Math.floor(Date.now() / 1000)),
    signature: `v1,${Buffer.from('x'.repeat(32)).toString('base64')}`,
  })
  assert.equal(r.status, 400)
  assert.equal(forwarded(), false)
})

await check('a valid signature replayed hours later is refused', async () => {
  // Signed correctly, just old — captured off the wire and sent again.
  const old = Math.floor(Date.now() / 1000) - 3600
  const r = await post(EVENT, await sign(EVENT, { timestamp: old }))
  assert.equal(r.status, 400)
  assert.equal(forwarded(), false)
})

await check('a signed event of another type is acknowledged, not forwarded', async () => {
  const other = JSON.stringify({ type: 'email.delivered', data: {} })
  const r = await post(other, await sign(other))
  // 200, or Svix retries it forever.
  assert.equal(r.status, 200)
  assert.equal(forwarded(), false)
})

await check('mail from the admin address is not forwarded back (loop guard)', async () => {
  received = { ...received, from: 'admin@example.com' }
  const r = await post(EVENT, await sign(EVENT))
  assert.equal(r.status, 200)
  assert.equal(forwarded(), false, 'an out-of-office would otherwise ping-pong')
  received = { ...received, from: 'stranger@example.net' }
})

await check('a sender who forged HTML into the banner cannot break out of it', async () => {
  received = { ...received, subject: '</div><script>alert(1)</script>' }
  await post(EVENT, await sign(EVENT))
  const sent = JSON.parse(calls.find((c) => c.url === 'https://api.resend.com/emails').body)
  assert.ok(!sent.html.includes('<script>'), 'the banner must escape what it prints')
  assert.ok(sent.html.includes('&lt;/div&gt;'))
  received = { ...received, subject: 'why was I rejected?' }
})

await check('a missing secret sends nothing rather than trusting the caller', async () => {
  const r = await handleInbound(
    new Request('https://hisaab.example/api/inbound', {
      method: 'POST',
      body: EVENT,
    }),
    { ...env, RESEND_WEBHOOK_SECRET: '' },
  )
  assert.equal(r.status, 500)
  assert.equal(forwarded(), false)
})

// ── Deciding by reply ────────────────────────────────────────────────────
//
// This is the path that exists so approving costs nothing but a reply — no
// link, no browser, no page on the app's domain. It is also the path where a
// misread turns into an account for someone you meant to turn away, hence the
// quoting tests: every mail client pastes our own instructions underneath the
// reply, and those instructions contain the word "approve".

/** A reply from the admin, landing on the address that carries the request id. */
const reply = (text, over = {}) => {
  received = {
    ...received,
    from: 'admin@example.com',
    to: DECIDE_TO,
    subject: 'Re: Hisaab: asker@example.net wants in',
    html: null,
    text,
    ...over,
  }
}

const QUOTED = `\n\nOn Thu, 13 Aug 2026 at 10:00, Hisaab <hello@example.com> wrote:\n> Reply approve and they are in.\n> Reply reject to turn them down.`

await check('replying "approve" creates the account and never forwards', async () => {
  reply(`approve${QUOTED}`)
  const r = await post(EVENT, await sign(EVENT))
  assert.equal(r.status, 200)
  assert.ok(accountMade(), 'the account should have been created')
  assert.ok(marked(), 'the row should have been marked decided')
  assert.equal(forwarded(), false, 'a decision is not a message to forward')

  const [toAsker, toAdmin] = mails()
  assert.deepEqual(toAsker.to, ['asker@example.net'], 'they get the welcome')
  assert.deepEqual(toAdmin.to, ['admin@example.com'], 'and the admin gets a receipt')
  assert.match(toAdmin.subject, /Approved/)
  assert.ok(toAdmin.html.includes('asker@example.net'))
})

await check('replying "no thanks" declines and creates nothing', async () => {
  reply(`no thanks${QUOTED}`)
  await post(EVENT, await sign(EVENT))
  assert.equal(accountMade(), false, 'reject must not create an account')
  assert.ok(marked())
  assert.match(mails().at(-1).subject, /Rejected/)
})

await check('the quoted copy of our own instructions cannot decide anything', async () => {
  // Nothing typed above the quote — the word "approve" is only in our mail
  // coming back. Reading the whole body would approve this.
  reply(QUOTED.trimStart())
  await post(EVENT, await sign(EVENT))
  assert.equal(accountMade(), false)
  assert.equal(marked(), false, 'nothing may be decided by a quote')
  assert.match(mails().at(-1).subject, /Say again/)
})

await check('a question gets asked again rather than guessed at', async () => {
  reply(`who is this?${QUOTED}`)
  await post(EVENT, await sign(EVENT))
  assert.equal(marked(), false)
  assert.match(mails().at(-1).subject, /Say again/)
})

await check('an HTML-only reply is read the same way', async () => {
  reply(null, {
    text: '',
    html: `<div>Approve</div><blockquote>Reply approve and they are in.</blockquote>`,
  })
  await post(EVENT, await sign(EVENT))
  assert.ok(accountMade(), 'the typed word is above the blockquote')
})

await check('somebody else replying to that address decides nothing', async () => {
  reply('approve', { from: 'stranger@example.net' })
  const r = await post(EVENT, await sign(EVENT))
  assert.equal(r.status, 200)
  assert.equal(marked(), false, 'a From that is not the admin must not decide')
  assert.equal(mails().length, 0, 'and it is not forwarded either — it is not a message')
})

await check('a reply about a request already decided says so, quietly', async () => {
  row = { ...row, status: 'approved' }
  reply(`approve${QUOTED}`)
  await post(EVENT, await sign(EVENT))
  assert.equal(accountMade(), false, 'a second reply must not re-create the account')
  assert.equal(marked(), false)
  assert.ok(mails().at(-1).html.includes('already approved'))
  row = { ...row, status: 'pending' }
})

await check('the first word is what counts', () => {
  assert.equal(readDecision('Approve'), 'approve')
  assert.equal(readDecision('yes!'), 'approve')
  assert.equal(readDecision('  ok \n> quoted'), 'approve')
  assert.equal(readDecision('Reject.'), 'reject')
  assert.equal(readDecision('nope'), 'reject')
  // A sentence that merely contains the word is not an answer.
  assert.equal(readDecision('should I approve this?'), null)
  assert.equal(readDecision(''), null)
  assert.equal(readDecision(undefined), null)
})

await check('the words a person actually types are the words that work', () => {
  // Nobody memorises a vocabulary for this. Every one of these is printed in
  // the mail (worker/lib/mail.js) — if one stops working, the mail is lying.
  for (const yes of ['let them in', 'Let him in', "let 'em in", 'go ahead', 'sure', 'fine', 'yep'])
    assert.equal(readDecision(yes), 'approve', yes)
  for (const no of ['keep them out', 'nah', 'never', 'not this one', 'block', 'deny'])
    assert.equal(readDecision(no), 'reject', no)

  // Hesitation is not a rejection, however much it starts like one.
  assert.equal(readDecision('not sure, who are they?'), null)
})

console.log(`\n${passed} checks passed`)
