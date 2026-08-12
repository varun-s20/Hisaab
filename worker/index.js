// Cloudflare Worker entry.
//
// The app is deployed to Cloudflare, and until this file existed the deploy was
// static assets only: `api/ask.js` and `api/categorise.js` are Vercel-shaped
// serverless functions and Cloudflare never ran them. Every POST to /api/ask
// fell through to the SPA fallback and came back as index.html, which postJson
// reads as a failure — so Ask silently used its local fallback parser for every
// question, and the AI tier of the categorise cascade never fired once.
//
// Rather than fork the two handlers, this bridges Cloudflare's (Request, env)
// to the (req, res) pair they already expect. One adapter, two routes, and the
// same code keeps working on Vercel.

import ask from '../api/ask.js'
import categorise from '../api/categorise.js'
import { handleAccess } from './access.js'
import { handleInbound } from './inbound.js'

const ROUTES = {
  '/api/ask': ask,
  '/api/categorise': categorise,
}

/**
 * The handlers read secrets off `process.env`, which on Workers is empty unless
 * something puts them there. Bindings arrive per-request; the values are the
 * same for every request in the isolate, so copying the string ones onto the
 * global is safe and costs nothing after the first call.
 */
function bridgeEnv(env) {
  if (!globalThis.process) globalThis.process = { env: {} }
  if (!globalThis.process.env) globalThis.process.env = {}
  for (const [k, v] of Object.entries(env ?? {})) {
    if (typeof v === 'string') globalThis.process.env[k] = v
  }
}

/**
 * True when a browser says this call came from somewhere that is not us.
 *
 * The app and both endpoints are served by this same Worker, so a real call is
 * always same-origin — and a browser attaches Origin to every POST, including
 * same-origin ones. A mismatch is another site spending our Gemini quota
 * through a tab someone happens to have open. There are deliberately no
 * Access-Control-Allow-Origin headers to go with this: nothing legitimate is
 * cross-origin, so there is nothing to allow.
 *
 * ponytail: this stops browsers, not curl — a script simply omits the header,
 * and no CORS rule ever written has changed that. requireUser in api/_auth.js
 * is what actually guards the key; this removes the drive-by case above it.
 */
function foreignOrigin(request) {
  const origin = request.headers.get('origin')
  return Boolean(origin) && origin !== new URL(request.url).origin
}

/** A Vercel-ish `res` that resolves into a real Response. */
function makeRes() {
  let status = 200
  let body = null
  const headers = new Headers()
  let settle
  const sent = new Promise((r) => {
    settle = r
  })

  const res = {
    statusCode: 200,
    status(code) {
      status = code
      res.statusCode = code
      return res
    },
    setHeader(k, v) {
      headers.set(k, v)
      return res
    },
    json(payload) {
      headers.set('content-type', 'application/json')
      body = JSON.stringify(payload)
      settle()
      return res
    },
    end(payload) {
      body = payload ?? null
      settle()
      return res
    },
  }

  return { res, sent, toResponse: () => new Response(body, { status, headers }) }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)

    // The approval routes speak native Request/Response and need the real env
    // (service role, Resend key) rather than the process.env bridge below, so
    // they are handled before the Vercel-shaped adapter gets involved.
    //
    // The Origin check applies to the POST only. /api/access-decide is opened
    // by tapping a link in a mail client, and a top-level GET navigation
    // carries no Origin header at all — checking it there would reject the one
    // request the route exists to serve.
    // Resend's inbound webhook. Deliberately outside the Origin check below:
    // it is a server-to-server POST that carries no Origin header, and it
    // authenticates itself with a signature over the raw body, which is a
    // stronger claim than any header a browser attaches.
    if (url.pathname === '/api/inbound') {
      try {
        return await handleInbound(request, env)
      } catch (e) {
        console.error('[inbound]', e?.message ?? e)
        // 500 rather than 200: Svix retries this, and a transient failure
        // should not silently eat somebody's email.
        return new Response('failed', { status: 500 })
      }
    }

    if (url.pathname === '/api/access-request' || url.pathname === '/api/access-decide') {
      if (request.method === 'POST' && foreignOrigin(request)) {
        return new Response(JSON.stringify({ error: 'not allowed from here' }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        })
      }
      try {
        const answer = await handleAccess(request, env, url)
        if (answer) return answer
      } catch (e) {
        // Supabase or Resend unreachable. The admin route is a page a person is
        // looking at, so it gets a sentence rather than a JSON blob.
        console.error('[access]', e?.message ?? e)
        return new Response('Something broke on our side. Nothing was changed.', {
          status: 500,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })
      }
    }

    const handler = ROUTES[url.pathname]

    // run_worker_first is scoped to /api/* in wrangler.jsonc, so this is only
    // reached for a path the static assets did not answer. Handing it back to
    // ASSETS keeps the SPA fallback working if that scoping ever changes.
    if (!handler) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 })
    }

    // Endpoints only. Static assets are meant to be reachable from anywhere,
    // and blocking them here would break the icons in an installed PWA.
    //
    // Checked before anything else runs, so a cross-origin OPTIONS preflight is
    // answered with this rather than falling into the handler's bare 405 — and
    // since the answer carries no CORS headers, the preflight fails and the
    // real request is never sent.
    if (foreignOrigin(request)) {
      return new Response(JSON.stringify({ error: 'not allowed from here' }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    }

    bridgeEnv(env)

    let body = {}
    if (request.method === 'POST') {
      try {
        body = await request.json()
      } catch {
        return new Response(JSON.stringify({ error: 'send JSON' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        })
      }
    }

    const req = {
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body,
    }

    const { res, sent, toResponse } = makeRes()
    try {
      // Whichever finishes first: a handler that returns without writing (it
      // cannot, today) would otherwise hang the request forever.
      await Promise.race([handler(req, res).then(() => sent), sent])
    } catch (e) {
      console.error('[worker]', e?.message ?? e)
      return new Response(JSON.stringify({ error: 'upstream failed' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    }
    return toResponse()
  },
}
