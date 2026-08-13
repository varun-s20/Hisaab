import { createClient } from '@supabase/supabase-js'

// Identity. Always this project, never a user's own.
//
// This file used to be lib/supabase.js and was the only Supabase client in the
// app — one client that was both "who you are" and "where your money is
// stored". Those are now two different things: a user may keep their ledger in
// their own Supabase project or on their device, but they always sign in here.
//
// That is deliberate and load-bearing. Sign-up is by approval (access_requests,
// worker/access.js) and the admin has to be able to remove someone. Both stop
// meaning anything the moment a user can point the app at an auth server the
// admin does not control. So: data is pluggable, identity is not.
//
// Everything that needs a session imports from here. Everything that needs a
// row imports from lib/db.js. Nothing should ever need both.

// `?? {}` because import.meta.env is a Vite construct and does not exist under
// plain node, where scripts/test-backends.mjs imports this file's dependents.
// Reading a property off undefined would fail at import time, before a single
// assertion ran.
const env = import.meta.env ?? {}
const url = env.VITE_SUPABASE_URL
const key = env.VITE_SUPABASE_ANON_KEY

export const configured = Boolean(url && key)

// Missing env shouldn't crash the app on load — the sign-in screen says what's
// wrong instead. createClient throws on empty strings, so guard it.
export const auth = configured
  ? createClient(url, key, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null

/**
 * The bearer token for our own /api/* endpoints.
 *
 * Always this project's token, whatever backend the caller's data lives in —
 * api/_auth.js verifies against this project and nothing else. A user on their
 * own Supabase still authenticates to the AI endpoints as themselves here.
 */
export async function accessToken() {
  const { data } = (await auth?.auth.getSession()) ?? {}
  return data?.session?.access_token ?? null
}

/**
 * Who is signed in, or null. Used as the key for anything stored per-person on
 * a shared device — the backend choice and its config, in lib/backend.js.
 */
export async function currentUserId() {
  const { data } = (await auth?.auth.getSession()) ?? {}
  return data?.session?.user?.id ?? null
}

// ── The rest of the app talks to identity through these ────────────────────
//
// Wrappers rather than a raw client, so `supabase.auth.*` appears in exactly
// one file. That is what stops a screen reaching for the identity client when
// it wanted the data one, which is the mistake this whole split exists to make
// impossible.

export async function getSession() {
  const { data } = (await auth?.auth.getSession()) ?? {}
  return data?.session ?? null
}

/** Returns an unsubscribe function. */
export function onAuthChange(handler) {
  const { data } = auth?.auth.onAuthStateChange((_event, session) => handler(session)) ?? {}
  return () => data?.subscription?.unsubscribe()
}

export const sendCode = (email, options) => auth.auth.signInWithOtp({ email, ...options })

export const verifyCode = (email, token) => auth.auth.verifyOtp({ email, token, type: 'email' })

export const signOut = () => auth.auth.signOut()
