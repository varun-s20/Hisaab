import { createClient } from '@supabase/supabase-js'
import { auth } from '../auth.js'
import { byoEmailFor, deriveByoPassword, normaliseUrl } from '../backend.js'
import { supabaseBackend } from './supabase.js'
import { localBackend } from './local.js'

// Turning a stored config into a live backend. The only place that knows how
// the three kinds differ.

/**
 * A client for the user's own project.
 *
 * `storageKey` is the load-bearing option. supabase-js persists its session
 * under a key derived from the project ref by default, but two clients in one
 * tab both writing session state is the kind of collision that shows up later
 * as a random sign-out — so the second client is given a key of its own,
 * namespaced by the Hisaab user so a shared device keeps two people apart.
 *
 * detectSessionInUrl is off: this client never handles a redirect. Only the
 * identity client in lib/auth.js does, and leaving it on here would have the
 * second client racing the first for the same URL fragment.
 */
function byoClient({ url, anonKey }, userId) {
  return createClient(normaliseUrl(url), anonKey, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: false,
      storageKey: `hisaab.byo.session.${userId}`,
    },
  })
}

/**
 * Sign in to the user's project as the account Hisaab keeps there, creating it
 * on first use.
 *
 * Sign in first, sign up only if that fails. The other order would call signUp
 * on every launch, which their project answers with a rate limit soon enough.
 *
 * The account exists because their project cannot verify a token minted by
 * ours. It is not the user's identity — that stays on Hisaab's project, always
 * — it is a device credential that lets the app reach a database the user owns.
 * See deriveByoPassword in lib/backend.js for why it is derived and what that
 * costs.
 */
async function signInToByo(client, config, userId) {
  // The client persists its session and refreshes it on its own, so most
  // launches already have one. Checking first is what stops every single app
  // open paying for a 600,000-iteration PBKDF2 — a few hundred milliseconds on
  // a phone, on the critical path before a single row can be read — plus a
  // sign-in round trip nobody asked for.
  const { data: existing } = await client.auth.getSession()
  if (existing?.session) return

  const email = byoEmailFor(userId)
  // Keyed on the project, not on the key that reaches it — see the note on
  // deriveByoPassword. Rotating the anon key must not lock somebody out of
  // their own ledger.
  const password = await deriveByoPassword(userId, config.url)

  const { error } = await client.auth.signInWithPassword({ email, password })
  if (!error) return

  const { error: signUpError } = await client.auth.signUp({ email, password })
  if (signUpError) {
    // The two likely misconfigurations, and Supabase's own wording for both
    // names neither the setting nor the page it is on. They are separate
    // toggles that fail at the same moment, so telling someone about only one
    // of them sends them back to a page they have already fixed.
    const message = signUpError.message ?? ''
    if (signUpError.code === 'signup_disabled' || /signups? not allowed|disabled/i.test(message)) {
      throw new Error(
        'Your project is not accepting new sign-ups. Turn on Authentication → Sign In / Providers → Allow new users to sign up, then try again.',
      )
    }
    if (/confirm/i.test(message)) {
      throw new Error(
        'Your project still requires email confirmation. Turn off Authentication → Sign In / Providers → Confirm email, then try again.',
      )
    }
    throw signUpError
  }

  // A project with confirmation switched off returns a session straight from
  // signUp. One that does not needs the explicit sign-in, and if that fails too
  // the error is the honest one to surface.
  const { data } = await client.auth.getSession()
  if (data?.session) return
  const { error: retry } = await client.auth.signInWithPassword({ email, password })
  if (retry) throw retry
}

/**
 * Build the backend a config describes. Throws with something a person can act
 * on if it cannot be reached — the settings screen shows the message.
 */
export async function createBackend(config, userId) {
  // The user id is what names the database. A device is not a person, and two
  // people on one phone must not open the same ledger — see local.js.
  if (config?.kind === 'local') return localBackend(userId)

  if (config?.kind === 'byo') {
    if (!userId) throw new Error('Sign in first.')
    const client = byoClient(config, userId)
    await signInToByo(client, config, userId)
    return supabaseBackend(client)
  }

  // cloud, and the fallback for anything unrecognised. Same client the user is
  // signed in with, which is what makes RLS scope every row to them.
  return supabaseBackend(auth)
}

export const BYO_TABLES = ['transactions', 'merchant_map', 'budgets', 'categories']

/**
 * Ask a project three questions without signing in to it: are you there, is
 * this key yours, and have the tables been made yet.
 *
 * All three come from one request per table, because PostgREST distinguishes
 * them in the error it returns. That matters for the setup flow: "your key is
 * wrong" and "you have not run the SQL yet" look identical from the outside if
 * you only check whether the call worked, and telling someone the wrong one
 * sends them to fix something that was never broken.
 *
 * No session is needed and none is created. Row level security filters rows
 * rather than refusing the request, so a table that exists answers with an
 * empty result even to an anonymous caller — which is exactly the signal
 * wanted here, and is why the SQL step can be checked before the account step.
 */
export async function probeByo({ url, anonKey }) {
  let client
  try {
    client = createClient(normaliseUrl(url), anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
  } catch {
    return { reachable: false, keyValid: false, missing: BYO_TABLES, message: 'That URL is not usable.' }
  }

  const results = await Promise.all(
    BYO_TABLES.map((table) =>
      client
        .from(table)
        .select('id', { count: 'exact', head: true })
        .then((r) => r)
        .catch((e) => ({ error: e })),
    ),
  )

  const errors = results.map((r) => r.error).filter(Boolean)
  const text = errors.map((e) => `${e.code ?? ''} ${e.message ?? ''}`).join(' | ')

  // A network-level failure means nothing answered at all — wrong host, or a
  // paused project. Neither is a key problem, and saying "check your key"
  // would send them to the wrong page.
  if (errors.length === BYO_TABLES.length && /fetch|network|ENOTFOUND|Load failed/i.test(text)) {
    return {
      reachable: false,
      keyValid: false,
      missing: BYO_TABLES,
      message: 'Nothing answered at that URL. Check it, or resume the project if it is paused.',
    }
  }

  if (/invalid api key|jwt|401|no api key/i.test(text)) {
    return {
      reachable: true,
      keyValid: false,
      missing: BYO_TABLES,
      message: 'The project answered but rejected that key. Copy the anon public key again.',
    }
  }

  // Anything left that failed is a table that has not been created yet.
  const missing = BYO_TABLES.filter((_, i) => results[i].error)
  return {
    reachable: true,
    keyValid: true,
    missing,
    message: missing.length ? `Not created yet: ${missing.join(', ')}.` : null,
  }
}

/**
 * Is this project's data actually protected?
 *
 * db/byo-setup.sql switches row level security on, and everything about the BYO
 * story rests on that: the anon key is designed to be public, so the policies
 * are the only thing standing between a stranger with that key and the user's
 * entire financial history. Nothing was checking it. Someone who edited the SQL,
 * ran an older copy of the schema, or turned RLS off later would have connected
 * without a word of complaint.
 *
 * Checked by asking without credentials. A table with RLS on and no anon policy
 * answers an unauthenticated caller with zero rows however many it holds — so a
 * row coming back here means the protection is not there.
 *
 * Returns null when it cannot tell, which is the case that matters most: an
 * empty ledger looks identical either way, so this is worth running AFTER the
 * data has moved rather than before. Never guesses; a maybe is reported as a
 * maybe.
 */
export async function rlsLooksOff({ url, anonKey }) {
  try {
    const bare = createClient(normaliseUrl(url), anonKey, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })
    const { data, error } = await bare.from('transactions').select('id').limit(1)
    if (error) return false // it refused us, which is the point
    if (!data) return null
    return data.length > 0
  } catch {
    return null
  }
}

/**
 * Supabase pauses a free project after about a week without activity, and the
 * failure a paused project produces looks like a broken app rather than a
 * dormant database. Recognising it is the difference between "Hisaab is
 * broken" and "tap here to wake your project up".
 */
export function looksPaused(error) {
  const message = String(error?.message ?? error ?? '')
  return /project is paused|paused|does not exist|fetch failed|Failed to fetch|ENOTFOUND/i.test(message)
}
