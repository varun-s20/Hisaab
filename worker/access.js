// The approval queue: ask, notify, decide.
//
// Three things live here, and they are deliberately not three files — they
// share the same table, the same service-role client, and reading one without
// the others tells you very little.
//
//   POST /api/access-request   someone unknown asks for an account
//   GET  /api/access-decide    the admin opens a link from that email
//   POST /api/access-decide    the admin presses the button on that page
//
// …and the way it is actually meant to be used, which involves no browser at
// all: the admin replies "approve" or "reject" to the notification. That reply
// lands on worker/inbound.js, which calls decideByReply() below. The links stay
// as a fallback — they are what works if inbound mail is not wired up.
//
// SECURITY, in one place, because the rest of this file assumes it:
//
//   * SUPABASE_SERVICE_ROLE_KEY bypasses row level security and can create
//     users. It exists only as a Worker secret. It is never sent to a browser,
//     never read by src/, and nothing here echoes it into a response or a log.
//   * The Approve / Reject links carry a signed, expiring, single-use token
//     (worker/lib/token.js). Anyone holding one can create an account, so the
//     GET renders a page and changes NOTHING. Link scanners, antivirus proxies
//     and mail-client prefetchers fetch URLs out of inboxes as a matter of
//     course; if the GET decided, the first such fetch would approve whoever
//     had just asked. The decision happens on a POST from a button on that
//     page, and the token dies with it because the row stops being 'pending'.
//   * The ask endpoint is unauthenticated by nature — the whole point is that
//     the caller has no account. Two caps below keep that from being a way to
//     spend the mail quota.

import { sign, verify } from './lib/token.js'
import * as mail from './lib/mail.js'

/** One admin email per address per this many hours, however often they ask. */
const COOLDOWN_HOURS = 24
/** …and never more than this many admin emails an hour across all addresses. */
const MAILS_PER_HOUR = 20
/** How long an Approve / Reject link stays good. */
const DECIDE_TTL = 7 * 24 * 60 * 60

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })

const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )

// ── Supabase, with the service role ──────────────────────────────────────

const sb = (env, path, init = {}) =>
  fetch(`${env.SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  })

/** Enough to write the row down. Without this there is nothing to be done. */
const canRecord = (env) => Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY)

/**
 * Enough to send the admin a decidable link. Kept separate from canRecord so a
 * missing mail secret loses the notification and not the request — the row is
 * still in the table for you to find, which is the difference between a quiet
 * deploy mistake and a person who asked and vanished.
 */
const canNotify = (env) =>
  Boolean(
    env.APPROVE_SECRET && env.ADMIN_EMAIL && env.RESEND_API_KEY && env.MAIL_FROM &&
    // SITE_URL is a security requirement here, not a nicety. The mail carries
    // Approve / Reject links, and without this the base for them falls back to
    // the origin of the request that triggered the send — which is the Host
    // header, chosen by whoever made the request. A forged one sends the admin
    // an email whose Approve link points at somebody else's server, and the
    // signed token travels with the tap. Same value is handed to Supabase as
    // the magic link's redirect_to.
    env.SITE_URL,
  )

// ── The page the admin lands on ──────────────────────────────────────────
//
// Server-rendered, no bundle, no JavaScript. The decision is an ordinary form
// POST, so it still works in a stripped-down in-app browser with scripts off —
// which is exactly where a link tapped inside Gmail tends to open.

const page = ({ site, title, heading, lead, form }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<title>${escapeHtml(title)}</title>
<style>
  :root { --page:#f1f1ed; --card:#fff; --rule:#e4e4e1; --text:#0e0f0c; --muted:#6a6c6a; }
  @media (prefers-color-scheme: dark) {
    :root { --page:#121511; --card:#1e211d; --rule:#2c302a; --text:#f3f5f1; --muted:#8f938c; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--page); color:var(--text); padding:32px 16px 64px;
         font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
         -webkit-font-smoothing:antialiased; }
  main { max-width:460px; margin:0 auto; }
  .panel { background:#9fe870; border-radius:26px; padding:26px 28px 24px; }
  .panel img { display:block; width:52px; height:52px; border-radius:13px; margin-bottom:18px; }
  .panel h1 { font-size:27px; font-weight:700; line-height:1.14; letter-spacing:-0.03em;
              color:#163300; margin:0; }
  .card { background:var(--card); border:1px solid var(--rule); border-radius:18px;
          padding:28px; margin-top:14px; }
  .lead { font-size:15px; line-height:1.55; margin:0; }
  .addr { font-size:19px; font-weight:700; word-break:break-all; margin:0 0 4px; }
  .muted { color:var(--muted); font-size:13px; line-height:1.6; }
  form { margin-top:22px; display:flex; flex-direction:column; gap:10px; }
  button { width:100%; padding:15px 20px; border:0; border-radius:14px; font:inherit;
           font-size:16px; font-weight:600; cursor:pointer; }
  button.go { background:#163300; color:#fff; }
  button.no { background:transparent; color:var(--text); border:1px solid var(--rule); }
  button:active { transform:scale(0.98); }
  hr { border:0; border-top:1px solid var(--rule); margin:20px 0 16px; }
</style></head>
<body><main>
  <div class="panel"><img src="${site}/icon-192.png" alt="Hisaab" /><h1>${heading}</h1></div>
  <div class="card">${lead}${form ?? ''}</div>
</main></body></html>`

/**
 * public/_headers is read by the static-asset server, not by a Worker, so a
 * Response built here starts with none of the app's security headers. This page
 * needs them more than most: its URL carries a live approval token.
 *
 * no-store is the one that matters — a token page sitting in a shared cache or
 * a mail client's offline copy is an approval waiting to be replayed. The rest
 * match public/_headers so the admin page is not the soft spot in the set.
 */
const html = (body, status = 200, nonce = null) =>
  new Response(body, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      // A nonce rather than 'unsafe-inline': the one script on this page is the
      // auto-submit below, and it is the thing that decides, so it is worth
      // naming exactly rather than opening the page to any inline script.
      'content-security-policy': `default-src 'self'; script-src ${
        nonce ? `'nonce-${nonce}'` : "'none'"
      }; style-src 'unsafe-inline'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
      'x-frame-options': 'DENY',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    },
  })

const dead = (site, line) =>
  html(
    page({
      site,
      title: 'Hisaab',
      heading: 'Nothing to do here.',
      lead: `<p class="lead">${escapeHtml(line)}</p>`,
    }),
    // 200, not 4xx: this is a person reading a page, and the only thing a
    // status code changes is whether some proxy replaces it with its own error.
    200,
  )

// ── POST /api/access-request ─────────────────────────────────────────────

const looksLikeEmail = (s) =>
  typeof s === 'string' && s.length >= 3 && s.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)

async function requestAccess(request, env, site) {
  let body
  try {
    body = await request.json()
  } catch {
    return json({ error: 'send JSON' }, 400)
  }

  // Lower-cased here so the row, the admin's mail, and the account created from
  // it are all the same string. Supabase treats addresses case-insensitively;
  // the unique index on access_requests.email does not.
  const email = String(body?.email ?? '')
    .trim()
    .toLowerCase()
  if (!looksLikeEmail(email)) return json({ error: 'that is not an email address' }, 400)

  if (!canRecord(env)) {
    console.error('[access] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing — request lost')
    // The person asking cannot fix this and must not be told about it. They see
    // the waiting-list line either way; the deploy is what is broken.
    return json({ ok: true })
  }

  const now = new Date().toISOString()

  // Upsert. A repeat ask — including from an address that was rejected — puts
  // the row back to 'pending', which is the behaviour asked for: anyone may ask
  // again. Only the columns named here are touched on conflict, so notified_at
  // survives and goes on holding the cooldown down below.
  const up = await sb(env, '/rest/v1/access_requests?on_conflict=email', {
    method: 'POST',
    headers: {
      prefer: 'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify([{ email, status: 'pending', created_at: now, decided_at: null }]),
  })
  if (!up.ok) {
    console.error('[access] upsert', up.status, (await up.text()).slice(0, 300))
    return json({ ok: true })
  }
  const row = (await up.json())[0]

  // Recorded either way. Only the telling-you-about-it part needs mail secrets.
  if (!canNotify(env)) {
    console.error('[access] mail secrets missing — recorded, but nobody was told')
    return json({ ok: true })
  }

  const fresh = (iso, hours) => iso && Date.now() - Date.parse(iso) < hours * 3600_000

  // Cap one: this address has already put a mail in the admin's inbox today.
  if (fresh(row.notified_at, COOLDOWN_HOURS)) return json({ ok: true })

  // Cap two: the whole table. Without this, a script feeding the endpoint a
  // fresh random address every second sends a mail every second, and the first
  // cap never fires because no address ever repeats.
  const since = new Date(Date.now() - 3600_000).toISOString()
  const recent = await sb(
    env,
    `/rest/v1/access_requests?select=id&notified_at=gte.${since}&limit=${MAILS_PER_HOUR + 1}`,
  )
  if (recent.ok && (await recent.json()).length >= MAILS_PER_HOUR) {
    console.warn('[access] hourly mail cap reached — not mailing about', email)
    return json({ ok: true })
  }

  const link = async (d) =>
    `${site}/api/access-decide?t=${encodeURIComponent(
      await sign({ id: row.id, d }, env.APPROVE_SECRET, DECIDE_TTL),
    )}`

  const sent = await mail.send(env, {
    to: env.ADMIN_EMAIL,
    subject: `Hisaab: ${email} wants in`,
    // Replying to the notification *is* the decision — this address carries the
    // row id back to worker/inbound.js. It used to reach the person who asked
    // instead, which was pleasant and is now in the way: an admin who taps Reply
    // must land on the thing that decides, not on a conversation.
    replyTo: replyAddress(env, row.id) ?? email,
    html: mail.adminRequest({
      site,
      email,
      asked: new Date(now).toUTCString(),
      approveUrl: await link('approve'),
      rejectUrl: await link('reject'),
    }),
  })

  // Stamped only on a mail that went, so a Resend outage does not silently burn
  // this address's 24 hours and leave the request invisible.
  if (sent) {
    await sb(env, `/rest/v1/access_requests?id=eq.${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ notified_at: new Date().toISOString() }),
    })
  }

  return json({ ok: true })
}

// ── GET / POST /api/access-decide ────────────────────────────────────────

/** The row, if it is there and still undecided. Marks a spent decision `gone`. */
async function pendingRow(env, id) {
  const r = await sb(
    env,
    `/rest/v1/access_requests?id=eq.${encodeURIComponent(id)}&select=id,email,status,created_at`,
  )
  if (!r.ok) return { gone: 'error' }
  const row = (await r.json())[0]
  if (!row) return { gone: 'expired' }
  if (row.status !== 'pending') return { gone: row.status }
  return { row }
}

/** The token's row, if the token is good and the row is still undecided. */
async function pending(env, token) {
  const claim = await verify(token, env.APPROVE_SECRET)
  if (!claim?.id || (claim.d !== 'approve' && claim.d !== 'reject')) return { gone: 'expired' }

  const found = await pendingRow(env, claim.id)
  return found.gone ? found : { ...found, decision: claim.d }
}

const goneLine = {
  expired:
    'That link has expired, or the request is no longer there. Ask them to request access again.',
  approved: 'That request was already approved. Nothing more to do.',
  rejected: 'That request was already rejected. Nothing more to do.',
  error: 'Could not reach the database. Try the link again in a minute.',
}

/** Create the account and get a one-tap link for it. Returns the URL, or null. */
async function letThemIn(env, email, site) {
  const made = await sb(env, '/auth/v1/admin/users', {
    method: 'POST',
    body: JSON.stringify({ email, email_confirm: true }),
  })
  // 422 is "already registered", which is a success for our purposes — it
  // happens if the same request is approved from two devices at once.
  if (!made.ok && made.status !== 422) {
    console.error('[access] create user', made.status, (await made.text()).slice(0, 300))
    return null
  }

  // A magic link, not a code, for this one mail: they have no app open to type
  // a code into yet. The mail carries the code route underneath it anyway.
  const gen = await sb(env, '/auth/v1/admin/generate_link', {
    method: 'POST',
    body: JSON.stringify({ type: 'magiclink', email, redirect_to: site }),
  })
  if (!gen.ok) {
    console.error('[access] generate_link', gen.status, (await gen.text()).slice(0, 300))
    return null
  }
  const j = await gen.json()
  // Older gotrue puts it at the top level, newer nests it under properties.
  return j?.action_link ?? j?.properties?.action_link ?? null
}

/**
 * Mark the row and tell the person. The only thing in this file that changes
 * anything — and both ways in, the button on the page and a reply to the mail,
 * come through here, so neither can drift from the other.
 *
 * Returns wording rather than a Response: one caller renders a page with it,
 * the other puts it in an email.
 */
async function carryOut(env, row, decision, site) {
  const stamp = (status) =>
    sb(env, `/rest/v1/access_requests?id=eq.${row.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ status, decided_at: new Date().toISOString() }),
    })

  if (decision === 'reject') {
    await stamp('rejected')
    await mail.send(env, {
      to: row.email,
      subject: 'About your Hisaab request',
      html: mail.declined({ site }),
    })
    return {
      heading: 'Rejected.',
      line: `${row.email} has been told, and no account was made.`,
      note: null,
    }
  }

  const link = await letThemIn(env, row.email, site)

  // Marked approved even when the link could not be generated: the account
  // exists by now, so leaving the row pending would let a second press try to
  // create it again. The mail below handles the missing link on its own.
  await stamp('approved')

  const sent = await mail.send(env, {
    to: row.email,
    subject: 'You’re in — welcome to Hisaab',
    html: mail.approved({ site, link }),
  })

  return {
    heading: 'Approved.',
    line: `${row.email} has an account${sent ? ' and a sign-in link on the way' : ''}.`,
    note: sent
      ? null
      : 'The welcome email did not send. They can still sign in: tell them to open Hisaab and ask for a code.',
  }
}

/**
 * The same decision, reached by replying to the notification instead of opening
 * one of its links. No token: the row id rides in the reply-to address, which
 * is 122 bits of randomness that exists only in the admin's own mailbox, and
 * worker/inbound.js additionally refuses a reply that is not from ADMIN_EMAIL.
 *
 * Always returns wording — the caller is a webhook with nobody to show a page
 * to, so every outcome including "that was already decided" has to be sayable
 * in the receipt it mails back.
 */
export async function decideByReply(env, id, decision, site) {
  if (!canRecord(env)) {
    console.error('[access] secrets missing — cannot decide')
    return {
      heading: 'Nothing changed.',
      line: 'This deploy is missing its secrets.',
      note: null,
    }
  }
  const { row, gone } = await pendingRow(env, id)
  if (gone) return { heading: 'Nothing to do.', line: goneLine[gone], note: null }
  return carryOut(env, row, decision, site)
}

/**
 * "Hisaab <hello@x.com>" → "hello+<row id>@x.com" — the address the admin's
 * reply comes back on, and the only thing that tells inbound.js which request
 * the reply is about. Plus-addressing rather than a subdomain because Resend
 * Inbound already receives everything at this domain, and because a signed
 * token would not fit: a local part is capped at 64 characters and one of ours
 * runs to about 165.
 *
 * null if MAIL_FROM has no address in it, in which case the caller falls back
 * to the links.
 */
export const replyAddress = (env, id) => {
  const at = (String(env.MAIL_FROM ?? '').match(/<([^>]*)>/)?.[1] ?? String(env.MAIL_FROM ?? ''))
    .trim()
    .toLowerCase()
  const cut = at.lastIndexOf('@')
  return cut < 1 ? null : `${at.slice(0, cut)}+${id}${at.slice(cut)}`
}

/** The row id a reply came back on, or null if it is ordinary mail. */
export const replyTag = (to) =>
  String(Array.isArray(to) ? to.join(',') : to ?? '').match(
    /\+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@/i,
  )?.[1] ?? null

async function decide(request, env, url, site) {
  // Deciding needs everything: the database to read and mark, the secret to
  // check the link with, and the mail to tell them either way.
  if (!canRecord(env) || !canNotify(env)) {
    console.error('[access] secrets missing — cannot decide')
    return dead(site, 'This deploy is missing its secrets. Nothing was changed.')
  }

  // ── The link itself. Renders and submits; still decides nothing on its own. ──
  //
  // One tap in the mail, as asked for: no button to press on this page. The
  // decision is carried out by a POST that the page issues on load.
  //
  // The GET is still inert, and that is the whole point of doing it this way
  // rather than simply acting on the GET. Mail clients, antivirus proxies and
  // corporate link scanners fetch URLs out of inboxes with nobody watching; a
  // GET that decided would approve whoever had just applied, silently and with
  // nothing looking wrong. Those fetchers pull HTML — they do not run it. So
  // the mutation lives behind a script, and the plain fetch changes nothing.
  //
  // ponytail: a scanner that executes JavaScript (Microsoft Safe Links does)
  // would get through this. The admin inbox is personal Gmail, which does not
  // crawl links in mail, so the exposure is theoretical here. Put the confirm
  // button back — it is the `<noscript>` block below, already written — if the
  // admin address ever moves to a Microsoft 365 or Proofpoint-filtered mailbox.
  if (request.method === 'GET') {
    const token = url.searchParams.get('t') ?? ''
    const { row, decision, gone } = await pending(env, token)
    if (gone) return dead(site, goneLine[gone])

    const approving = decision === 'approve'
    const nonce = crypto.randomUUID().replace(/-/g, '')
    return html(
      page({
        site,
        title: 'Hisaab',
        heading: approving ? 'Approving…' : 'Rejecting…',
        lead: `<p class="addr">${escapeHtml(row.email)}</p>
               <p class="muted">${
                 approving
                   ? 'Creating their account and sending them a sign-in link.'
                   : 'Sending them a short decline. They can ask again later.'
               }</p>`,
        // Hidden inputs only, so with scripting on there is nothing to look at
        // and nothing to press. The noscript button is the whole fallback.
        form: `<form id="go" method="post" action="/api/access-decide">
                 <input type="hidden" name="t" value="${escapeHtml(token)}" />
                 <input type="hidden" name="d" value="${escapeHtml(decision)}" />
                 <noscript>
                   <button class="${approving ? 'go' : 'no'}" type="submit">
                     ${approving ? 'Approve' : 'Reject'} ${escapeHtml(row.email)}
                   </button>
                 </noscript>
               </form>
               <script nonce="${nonce}">document.getElementById('go').submit()</script>`,
      }),
      200,
      nonce,
    )
  }

  // ── The button. This is the only thing that changes anything. ──
  const form = await request.formData()
  const token = String(form.get('t') ?? '')
  const pressed = String(form.get('d') ?? '')
  if (pressed !== 'approve' && pressed !== 'reject') return dead(site, 'That form was incomplete.')

  const { row, gone } = await pending(env, token)
  if (gone) return dead(site, goneLine[gone])

  const { heading, line, note } = await carryOut(env, row, pressed, site)
  return html(
    page({
      site,
      title: `Hisaab — ${pressed === 'approve' ? 'approved' : 'rejected'}`,
      heading,
      lead: `<p class="lead">${escapeHtml(line)}</p>${
        note ? `<p class="muted">${escapeHtml(note)}</p>` : ''
      }`,
    }),
  )
}

// ── Router ───────────────────────────────────────────────────────────────

/**
 * Returns a Response for a path this file owns, or null so the caller can carry
 * on. Native Request/Response — the Vercel-shaped adapter in worker/index.js is
 * for api/ask.js and api/categorise.js, which have to keep running on Vercel
 * too. Nothing here does.
 */
export function handleAccess(request, env, url) {
  // Absolute, because these end up in emails. SITE_URL wins so the links point
  // at the real domain even when the Worker is reached on its workers.dev name.
  //
  // The fallback survives only for what this Worker renders itself — the decide
  // page's own logo and styling. Nothing that leaves in an email is built from
  // it: canNotify() above refuses to send at all without SITE_URL.
  const site = (env.SITE_URL || url.origin).replace(/\/$/, '')

  if (url.pathname === '/api/access-request') {
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405)
    return requestAccess(request, env, site)
  }

  if (url.pathname === '/api/access-decide') {
    if (request.method !== 'GET' && request.method !== 'POST') {
      return json({ error: 'GET or POST' }, 405)
    }
    return decide(request, env, url, site)
  }

  return null
}
