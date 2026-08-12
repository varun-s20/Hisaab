// Shared by both endpoints. Underscore-prefixed so Vercel treats it as a
// helper rather than a route.
//
// Neither endpoint used to check anything but the HTTP verb, which made both of
// them a free LLM billed to whoever deployed the app: `curl` in a loop spends
// GEMINI_API_KEY until the quota is gone, and a spent quota is also a denial of
// service against the app's own Ask and Teach screens. `ask` was the more
// attractive target because it returns the model's output close to verbatim.
//
// The browser already holds a Supabase access token, so the cheapest honest
// check is to hand it back to Supabase and ask who it belongs to. That needs no
// new secret: the URL and the anon key are the same public values already
// baked into the client bundle.

// Read per call, not at import. On Cloudflare the bindings only exist once a
// request is in flight (see worker/index.js), so a module-level read here is
// always undefined and the fail-closed branch below would reject every caller.
const project = () => process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const anon = () => process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

/**
 * True when the caller proved they are a signed-in user. Writes the error
 * response itself and returns false otherwise, so a handler reads:
 *
 *   if (!(await requireUser(req, res))) return
 */
export async function requireUser(req, res) {
  const token = /^Bearer\s+(.+)$/i.exec(req.headers?.authorization ?? '')?.[1]
  if (!token) {
    res.status(401).json({ error: 'sign in' })
    return false
  }

  const PROJECT = project()
  const ANON = anon()

  // Fail closed. A misconfigured deploy that silently accepted everyone would
  // be indistinguishable from no check at all.
  if (!PROJECT || !ANON) {
    console.error('[auth] SUPABASE_URL / SUPABASE_ANON_KEY are not set — refusing every request')
    res.status(500).json({ error: 'server is misconfigured' })
    return false
  }

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 5000)
    const r = await fetch(`${PROJECT}/auth/v1/user`, {
      headers: { apikey: ANON, authorization: `Bearer ${token}` },
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!r.ok) {
      res.status(401).json({ error: 'sign in' })
      return false
    }
    return true
  } catch (e) {
    console.error('[auth]', e?.message ?? e)
    res.status(401).json({ error: 'sign in' })
    return false
  }
}
