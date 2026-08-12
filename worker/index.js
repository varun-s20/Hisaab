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
    const handler = ROUTES[url.pathname]

    // run_worker_first is scoped to /api/* in wrangler.jsonc, so this is only
    // reached for a path the static assets did not answer. Handing it back to
    // ASSETS keeps the SPA fallback working if that scoping ever changes.
    if (!handler) {
      return env.ASSETS ? env.ASSETS.fetch(request) : new Response('Not found', { status: 404 })
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
