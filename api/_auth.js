// Shared by both endpoints. Underscore-prefixed so Vercel treats it as a
// helper rather than a route.
//
// Neither endpoint used to check anything but the HTTP verb, which made both of
// them a free LLM billed to whoever deployed the app: `curl` in a loop spends
// GEMINI_API_KEY until the quota is gone, and a spent quota is also a denial of
// service against the app's own Ask and Teach screens. `ask` was the more
// attractive target because it returns the model's output close to verbatim.
//
// The browser already holds a Hisaab access token, so the cheapest honest check
// is to hand it back to Supabase and ask who it belongs to. That needs no new
// secret: the URL and the anon key are the same public values already baked
// into the client bundle.
//
// Always Hisaab's project, never a user's own. Someone whose ledger lives in
// their own Supabase or on their phone still signs in here, so this check works
// for all three backends — where the rows are stored has nothing to do with who
// is calling. See src/lib/auth.js.

// Read per call, not at import. On Cloudflare the bindings only exist once a
// request is in flight (see worker/index.js), so a module-level read here is
// always undefined and the fail-closed branch below would reject every caller.
const project = () => process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL
const anon = () => process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY

/**
 * How many model calls one person may make in a day.
 *
 * Real use is nowhere near this: an entire statement import is one batched
 * call, a Teach session is one, a question is one. The number exists so that
 * one person on a bad day — or one account that got loose — cannot spend the
 * quota everybody shares. A spent quota is an outage for every user at once.
 */
const dailyCap = () => Number(process.env.AI_DAILY_CAP || 100)

/**
 * The user id behind a valid token, or null once an error response is written.
 * A handler reads:
 *
 *   const userId = await requireUser(req, res)
 *   if (!userId) return
 */
export async function requireUser(req, res) {
  const token = /^Bearer\s+(.+)$/i.exec(req.headers?.authorization ?? '')?.[1]
  if (!token) {
    res.status(401).json({ error: 'sign in' })
    return null
  }

  const PROJECT = project()
  const ANON = anon()

  // Fail closed. A misconfigured deploy that silently accepted everyone would
  // be indistinguishable from no check at all.
  if (!PROJECT || !ANON) {
    console.error('[auth] SUPABASE_URL / SUPABASE_ANON_KEY are not set — refusing every request')
    res.status(500).json({ error: 'server is misconfigured' })
    return null
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
      return null
    }
    // The id was always in this response and was always thrown away, which is
    // why there was never any way to tell one caller from another — or to stop
    // one of them spending everything.
    const user = await r.json()
    return user?.id ?? null
  } catch (e) {
    console.error('[auth]', e?.message ?? e)
    res.status(401).json({ error: 'sign in' })
    return null
  }
}

/**
 * Count this call against the user's day, and say whether they may have it.
 *
 * Counted through an RPC rather than a read-then-write, so two calls landing at
 * once cannot both read the same number and each store it plus one. See
 * bump_ai_usage in db/schema.sql.
 *
 * Fails OPEN, deliberately. If the counter is unreachable the choice is between
 * refusing a legitimate call and letting one through uncounted; refusing turns
 * a hiccup in an ancillary table into the AI being down for everybody, and the
 * thing being protected is a spending limit rather than anyone's data.
 */
export async function withinQuota(userId, res) {
  const PROJECT = project()
  const SERVICE = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!PROJECT || !SERVICE || !userId) return true

  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)
    const r = await fetch(`${PROJECT}/rest/v1/rpc/bump_ai_usage`, {
      method: 'POST',
      headers: {
        apikey: SERVICE,
        authorization: `Bearer ${SERVICE}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ uid: userId }),
      signal: controller.signal,
    })
    clearTimeout(timer)
    if (!r.ok) {
      console.error('[quota] bump_ai_usage returned', r.status, '— letting the call through')
      return true
    }

    const calls = Number(await r.json())
    if (Number.isFinite(calls) && calls > dailyCap()) {
      res.status(429).json({
        error: 'daily limit reached',
        // Said plainly, because the screens show it and "429" is not something
        // anybody can act on.
        message: 'You have used up today’s AI. It resets tomorrow — or add your own Gemini key in Settings to stop sharing the limit.',
      })
      return false
    }
    return true
  } catch (e) {
    console.error('[quota]', e?.message ?? e, '— letting the call through')
    return true
  }
}
