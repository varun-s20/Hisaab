import { accessToken } from './auth'

// Every call to our own /api/* goes through here, because both endpoints spend
// the owner's Gemini quota and now require a signed-in caller (see api/_auth.js).
// One place to attach the token means a new endpoint can't forget to.
//
// The token is always Hisaab's, never the user's own project's — api/_auth.js
// verifies against Hisaab's Supabase and nothing else. Someone whose ledger
// lives in their own database still calls these endpoints as themselves.

/**
 * POST JSON to one of our functions with the caller's Supabase token attached.
 * Returns the parsed body, or null on any failure — every caller of this fails
 * soft by design, so a thrown error would only ever be swallowed one level up.
 */
export async function postJson(path, body) {
  try {
    const token = await accessToken()
    if (!token) return null

    const r = await fetch(path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
    if (!r.ok) return null
    return await r.json()
  } catch {
    return null
  }
}
