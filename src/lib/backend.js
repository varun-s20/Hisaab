// Where a person's ledger is stored, and the settings that describe it.
//
// Three choices, one interface (see lib/db.js):
//
//   cloud  Hisaab's own Supabase. The default, and what every existing user is
//          on. Nothing about it changes.
//   byo    The user's own Supabase project. Their infrastructure, their region,
//          their backups. We hold no key to it.
//   local  This device. IndexedDB, no network, no account anywhere.
//
// Identity is NOT part of this choice — see lib/auth.js. Every user signs in to
// Hisaab's project whichever of these they pick.

export const KINDS = ['cloud', 'byo', 'local']

export const DEFAULT = { kind: 'cloud' }

/**
 * Stored per signed-in user, not per device.
 *
 * A shared phone can carry two people's settings, and one of them naming their
 * own Supabase project must not point the other's ledger at it. Same reasoning
 * as the owner check on custom categories in lib/categories.js, which had to
 * learn this the hard way.
 */
const keyFor = (userId) => `hisaab.backend.${userId}`

export function readConfig(userId) {
  if (!userId) return DEFAULT
  try {
    const raw = JSON.parse(localStorage.getItem(keyFor(userId)) ?? 'null')
    if (!raw || !KINDS.includes(raw.kind)) return DEFAULT
    // A byo row missing either half is not a backend, it is a half-finished
    // setup. Falling back to cloud is the safe reading: it shows the user their
    // existing data rather than an error, and the setup screen still says the
    // connection is incomplete.
    if (raw.kind === 'byo' && !(raw.url && raw.anonKey)) return DEFAULT
    return raw
  } catch {
    return DEFAULT
  }
}

export function writeConfig(userId, config) {
  if (!userId) throw new Error('Sign in first.')
  localStorage.setItem(keyFor(userId), JSON.stringify(config))
}

export function clearConfig(userId) {
  if (userId) localStorage.removeItem(keyFor(userId))
}

// ── Validating what someone pastes ─────────────────────────────────────────

/**
 * Supabase's own keys are the two things a user copies out of their dashboard,
 * and the page they copy from shows both. Pasting the wrong one is a security
 * incident rather than a typo: the service role key bypasses row level security
 * entirely, so a copy of it in localStorage would hand every script on the page
 * unrestricted access to their whole database — not just their ledger.
 *
 * Both key formats are checked. The legacy keys are JWTs carrying a `role`
 * claim; the newer ones are prefixed strings.
 */
export function keyProblem(anonKey) {
  const key = String(anonKey ?? '').trim()
  if (!key) return 'Paste the anon public key.'

  if (key.startsWith('sb_secret_')) {
    return 'That is the secret key. Copy the publishable one — the secret key must never leave your dashboard.'
  }
  if (key.startsWith('sb_publishable_')) return null

  const role = jwtRole(key)
  if (role === 'service_role') {
    return 'That is the service_role key. Copy the anon public key — service_role bypasses row level security and must never leave your dashboard.'
  }
  if (role === 'anon') return null
  return 'That does not look like a Supabase API key.'
}

/** The `role` claim, or null if this is not a readable JWT. Signature is not
 *  checked and does not need to be — their project is what verifies it. This
 *  only has to tell two of the user's own keys apart. */
function jwtRole(token) {
  try {
    const payload = token.split('.')[1]
    if (!payload) return null
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json)?.role ?? null
  } catch {
    return null
  }
}

/**
 * A Supabase project reference — the string the dashboard now shows as
 * "Project ID". Twenty lowercase characters in practice; the range is loose
 * here because it is Supabase's to change and a wrong guess would reject a
 * valid project.
 */
const REF = /^[a-z0-9]{16,32}$/

/**
 * What the user pastes, turned into something fetch can use.
 *
 * The dashboard leads with the project ID rather than the full URL, so that is
 * what people have to hand and what the setup screen asks for. A pasted URL
 * still works — someone copying from an older guide, and anyone self-hosting,
 * has one instead of a ref.
 */
export function resolveUrl(input) {
  const raw = String(input ?? '').trim().replace(/\/+$/, '')
  if (REF.test(raw)) return `https://${raw}.supabase.co`
  return raw
}

/**
 * Their project, as an ID or a URL.
 *
 * https is required, because the anon key and the derived password below are
 * sent to it. The one exception is a loopback address, which is how someone
 * running `supabase start` on their own machine reaches their instance and
 * never crosses a network to do it.
 */
export function urlProblem(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return 'Paste your project ID.'
  if (REF.test(raw)) return null

  let u
  try {
    u = new URL(resolveUrl(raw))
  } catch {
    return 'That does not look like a project ID. It is the short string under Project Settings → General.'
  }
  const loopback = u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]'
  if (u.protocol !== 'https:' && !loopback) {
    return 'Use https. Your key would be sent in the clear otherwise.'
  }
  if (u.pathname !== '/' && u.pathname !== '') {
    return 'Just the project ID, or the plain project URL with nothing after the host.'
  }
  return null
}

export const normaliseUrl = resolveUrl

// ── The BYO access credential ──────────────────────────────────────────────

/**
 * The password of the account Hisaab keeps in the user's own project.
 *
 * Their project cannot verify a token minted by ours — Supabase validates a JWT
 * against the project's own signing key — so the app needs a credential that is
 * real over there. It creates one silently on first connect (see signInToByo in
 * lib/backends/index.js); the user never sees or types it.
 *
 * Derived rather than random, because a random password lives on exactly one
 * device. Connecting a second phone would then be impossible without copying a
 * secret between them, and "paste your project ID and key again" is the whole
 * of the onboarding we promised.
 *
 * Derived from the HOST, not the anon key, and that distinction is load-bearing.
 * Keyed on the anon key, rotating that key — or taking Supabase up on "Disable
 * JWT-based API keys", a button on the very page they copy it from — would
 * change the password out from under an account that already exists. The app
 * would then fail to sign in, fail to sign up because the account is already
 * there, and the user would be locked out of their own data with no way back.
 * A project's host never changes for its lifetime.
 *
 * The security is the same either way. Someone has to hold the anon key to
 * reach the project at all, and the host is in the URL they would be using it
 * against — so both versions reduce to "the anon key, plus their Hisaab user
 * id". It is still meaningfully better than leaving the tables open to the anon
 * role, which is the alternative: there the key alone is enough, and the key is
 * the half that leaks, in a screenshot of the API settings page.
 *
 * PBKDF2 is what the platform gives us for free. The iteration count is what
 * OWASP recommends for SHA-256 at the time of writing.
 */
const KDF_SALT = 'hisaab.byo.credential.v1'
const KDF_ITERATIONS = 600_000

export async function deriveByoPassword(userId, projectUrl) {
  if (!userId || !projectUrl) throw new Error('Both a signed-in user and a project are needed.')

  // The host alone, so a trailing slash, a stray path, or http against https
  // cannot produce two different passwords for the same project.
  let host
  try {
    host = new URL(resolveUrl(projectUrl)).host.toLowerCase()
  } catch {
    throw new Error('That project address is not usable.')
  }

  const enc = new TextEncoder()
  const material = await crypto.subtle.importKey(
    'raw',
    // NUL-separated so a user id ending in the first characters of a host
    // cannot produce the same input as a different pair. Ambiguity here would
    // let two distinct projects share a password.
    enc.encode(`${userId} ${host}`),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: enc.encode(KDF_SALT), iterations: KDF_ITERATIONS, hash: 'SHA-256' },
    material,
    256,
  )
  // Supabase requires a password, not a byte string. base64url keeps it to
  // characters that survive JSON, headers and anyone's clipboard.
  return btoa(String.fromCharCode(...new Uint8Array(bits)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * The address the silent account is created under, inside their project.
 *
 * Their real address would be the obvious choice and is the wrong one: it makes
 * the account look like a personal login they can reset from their dashboard,
 * and a reset would lock the app out of their own data with no way back. A
 * name that says what it is prevents that.
 */
export const byoEmailFor = (userId) => `hisaab+${userId}@device.local`
