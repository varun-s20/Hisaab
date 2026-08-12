// The signed token in the Approve / Reject links.
//
// The mail that goes to the admin carries two URLs, and whoever holds one can
// create an account on this project. So the decision it names has to be sealed
// against the person holding the link: no database lookup by a guessable id, no
// `?decision=approve` a curious hand can edit, no unbounded lifetime.
//
// Shape is a cut-down JWS — base64url(JSON payload).base64url(HMAC-SHA256) —
// rather than a real JWT, because nothing here needs an algorithm field, and an
// algorithm field is the part of JWT that keeps getting people hurt.
//
// WebCrypto only, so the same file runs unchanged on Cloudflare Workers and
// under `node scripts/test-token.mjs`.

const enc = new TextEncoder()
const dec = new TextDecoder()

// Payloads are ~100 bytes and the MAC is 32, so spreading into fromCharCode is
// nowhere near the argument limit that makes this pattern a bug elsewhere.
const b64url = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')

const unb64url = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))

const hmacKey = (secret) =>
  crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ])

/**
 * Seal a payload. `ttlSeconds` becomes an `exp` inside the signed bytes — an
 * expiry outside the signature is a suggestion, not a limit.
 */
export async function sign(payload, secret, ttlSeconds) {
  const body = b64url(
    enc.encode(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds })),
  )
  const mac = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body))
  return `${body}.${b64url(mac)}`
}

/**
 * The payload if the token is intact and unexpired, otherwise null. One return
 * value for every kind of failure on purpose: the caller has nothing useful to
 * say about *which* way a bad link was bad, and saying it would be a hint.
 *
 * crypto.subtle.verify does the comparison, so this never hand-rolls the
 * byte-by-byte equality that leaks a signature one character at a time.
 */
export async function verify(token, secret) {
  const [body, mac] = String(token ?? '').split('.')
  if (!body || !mac) return null

  try {
    const ok = await crypto.subtle.verify(
      'HMAC',
      await hmacKey(secret),
      unb64url(mac),
      enc.encode(body),
    )
    if (!ok) return null

    const payload = JSON.parse(dec.decode(unb64url(body)))
    // Missing exp is not "never expires", it is a token this code did not make.
    if (typeof payload?.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null
    return payload
  } catch {
    // Malformed base64, or a payload that is not JSON. Same answer.
    return null
  }
}
