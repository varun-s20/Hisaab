// The Approve / Reject links are the one place in this app where a URL creates
// an account. If sign/verify goes soft, that URL becomes forgeable and nothing
// else in the system would notice. So: assertions, no framework.
//
//   node scripts/test-token.mjs

import assert from 'node:assert/strict'
import { sign, verify } from '../worker/lib/token.js'

const SECRET = 'test-secret-not-the-real-one'
const HOUR = 3600

let passed = 0
async function check(label, fn) {
  await fn()
  passed++
  console.log('  ok  ', label)
}

/** Sign a body the way token.js does, to isolate what the payload rules reject. */
async function signRaw(payloadObject) {
  const body = Buffer.from(JSON.stringify(payloadObject)).toString('base64url')
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))
  return `${body}.${Buffer.from(sig).toString('base64url')}`
}

const good = await sign({ id: 'abc-123', d: 'approve' }, SECRET, HOUR)
const [body, mac] = good.split('.')

await check('a freshly signed token verifies, payload intact', async () => {
  const claim = await verify(good, SECRET)
  assert.ok(claim, 'expected a payload')
  assert.equal(claim.id, 'abc-123')
  assert.equal(claim.d, 'approve')
  assert.equal(typeof claim.exp, 'number')
})

await check('a swapped payload on a valid signature is refused', async () => {
  const forged = Buffer.from(
    JSON.stringify({ id: 'someone-else', d: 'approve', exp: 2 ** 40 }),
  ).toString('base64url')
  assert.equal(await verify(`${forged}.${mac}`, SECRET), null)
})

await check('a forged signature is refused', async () => {
  assert.equal(await verify(`${body}.${'A'.repeat(mac.length)}`, SECRET), null)
})

await check('the wrong secret is refused', async () => {
  assert.equal(await verify(good, 'a-different-secret'), null)
})

await check('an expired token is refused', async () => {
  assert.equal(await verify(await sign({ id: 'abc-123', d: 'approve' }, SECRET, -1), SECRET), null)
})

await check('a correctly signed token with no expiry is still refused', async () => {
  assert.equal(await verify(await signRaw({ id: 'x', d: 'approve' }), SECRET), null)
})

await check('a non-numeric expiry is refused', async () => {
  assert.equal(await verify(await signRaw({ id: 'x', d: 'approve', exp: 'later' }), SECRET), null)
})

await check('malformed tokens are refused', async () => {
  for (const junk of ['', null, undefined, 'nodot', 'a.b.c', '.', 'x.', '.y', '!!!.???']) {
    assert.equal(await verify(junk, SECRET), null, `expected null for ${JSON.stringify(junk)}`)
  }
})

console.log(`\n${passed} checks passed`)
