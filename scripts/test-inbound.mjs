// /api/inbound is a public URL that makes the app send mail. The Svix
// signature is the ONLY thing in front of it, so these assertions are the
// difference between a forwarder and an open relay pointed at your inbox.
//
//   node scripts/test-inbound.mjs

import assert from 'node:assert/strict'
import { handleInbound } from '../worker/inbound.js'

const SECRET_BYTES = Buffer.from('a'.repeat(32))
const env = {
  RESEND_WEBHOOK_SECRET: `whsec_${SECRET_BYTES.toString('base64')}`,
  RESEND_API_KEY: 're_test',
  ADMIN_EMAIL: 'admin@example.com',
  MAIL_FROM: 'Hisaab <hello@example.com>',
}

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
    new Response(JSON.stringify(v), { status: 200, headers: { 'content-type': 'application/json' } })
  if (String(url).includes('/emails/receiving/')) return j(received)
  if (String(url) === 'https://api.resend.com/emails') return j({ id: 'sent_1' })
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
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`))
  return { id, timestamp: String(timestamp), signature: `v1,${Buffer.from(mac).toString('base64')}` }
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

const EVENT = JSON.stringify({ type: 'email.received', data: { email_id: 'em_1' } })
const forwarded = () => calls.some((c) => c.url === 'https://api.resend.com/emails')

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
  const tampered = JSON.stringify({ type: 'email.received', data: { email_id: 'em_EVIL' } })
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
    new Request('https://hisaab.example/api/inbound', { method: 'POST', body: EVENT }),
    { ...env, RESEND_WEBHOOK_SECRET: '' },
  )
  assert.equal(r.status, 500)
  assert.equal(forwarded(), false)
})

console.log(`\n${passed} checks passed`)
