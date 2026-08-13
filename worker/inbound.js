// Mail arriving at the brand address: a decision, or something to forward on.
//
// Two jobs, one webhook, because Resend delivers both to the same endpoint.
//
//   * A reply to "someone wants in" comes back to hello+<request id>@domain.
//     That is an approval — the first word of the reply decides it and a
//     receipt goes back. No browser opens at any point, which is the entire
//     reason this path exists: tapping a link in the mail meant a page load on
//     the app's domain, and the decision was never meant to cost that.
//   * Anything else is somebody writing to the brand address, and gets
//     forwarded to a human.
//
// Resend Inbound is not a mailbox. When mail arrives at hello@<domain> it POSTs
// a webhook here — carrying metadata only, never the body — and the body has to
// be fetched back over the API. Without something at this end, a reply to an
// approval or a decline is captured and never seen.
//
//   POST /api/inbound   Resend calls this. Nobody else legitimately does.
//
// SECURITY: this is a public, unauthenticated-by-URL endpoint that causes mail
// to be sent. The only thing standing in front of it is the Svix signature, so:
//
//   * the RAW body is verified before it is parsed. Parsing first and verifying
//     the re-serialised result would verify a different string than the one
//     that was signed, which is the classic way this check gets quietly broken.
//   * the timestamp is checked against a 5-minute window, so a signature
//     captured off the wire cannot be replayed tomorrow.
//   * comparison is crypto.subtle.verify, not string equality on a base64
//     digest.
//   * a request that fails any of the above is a 400 that sends nothing.

import { decideByReply, replyTag } from './access.js'
import { receipt, send } from './lib/mail.js'

const MAX_SKEW_SECONDS = 300

const enc = new TextEncoder()

const b64bytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

const escapeHtml = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )

/**
 * Svix's scheme, by hand — the SDK is a dependency in the cold start for one
 * HMAC. Signed content is `{id}.{timestamp}.{raw body}`; the secret is
 * `whsec_` followed by base64 key bytes; the header holds space-separated
 * `version,signature` pairs, plural so a key can be rotated without downtime.
 */
async function verified(secret, headers, rawBody) {
  const id = headers.get('svix-id')
  const timestamp = headers.get('svix-timestamp')
  const signature = headers.get('svix-signature')
  if (!id || !timestamp || !signature) return false

  const sent = Number(timestamp)
  if (!Number.isFinite(sent) || Math.abs(Date.now() / 1000 - sent) > MAX_SKEW_SECONDS) return false

  let key
  try {
    key = await crypto.subtle.importKey(
      'raw',
      b64bytes(secret.replace(/^whsec_/, '')),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify'],
    )
  } catch {
    console.error('[inbound] RESEND_WEBHOOK_SECRET is not a whsec_ value')
    return false
  }

  const signed = enc.encode(`${id}.${timestamp}.${rawBody}`)
  for (const part of signature.split(' ')) {
    const [version, sig] = part.split(',')
    if (version !== 'v1' || !sig) continue
    try {
      if (await crypto.subtle.verify('HMAC', key, b64bytes(sig), signed)) return true
    } catch {
      // Not base64. Try the next one rather than failing the whole header.
    }
  }
  return false
}

// ── Who sent it ──────────────────────────────────────────────────────────

/**
 * The address out of a From header, lower-cased, with any plus-tag removed.
 *
 * `Hisaab <hello@example.com>` → `hello@example.com`, and
 * `k+phone@example.com` → `k@example.com`, so the admin writing from an alias
 * of their own still counts as the admin.
 */
const mailbox = (header) => {
  const raw = (String(header ?? '').match(/<([^>]*)>/)?.[1] ?? String(header ?? '')).trim().toLowerCase()
  const at = raw.lastIndexOf('@')
  if (at < 1) return ''
  const local = raw.slice(0, at).split('+')[0]
  return `${local}${raw.slice(at)}`
}

/**
 * Is this mail from the admin?
 *
 * An exact comparison of the *address*, never a substring of the header. The
 * header carries a display name the sender chooses, so `includes` — which is
 * what this used to be — matched a stranger who simply named themselves after
 * the admin: `"k@example.com" <attacker@elsewhere.test>` passed it. That check
 * is the backstop for a decision address that has leaked (a forwarded thread, a
 * screenshot of an inbox), which is precisely the situation where somebody is
 * already choosing what their headers say.
 */
export const sameMailbox = (header, address) => {
  const a = mailbox(header)
  return Boolean(a) && a === mailbox(address)
}

// ── Reading a one-word reply ─────────────────────────────────────────────

/**
 * What the admin actually typed, above the copy of our own mail underneath it.
 *
 * Every mail client quotes the original, so the naive "does the body contain
 * the word approve" would match the instructions we sent, and every reply would
 * be an approval. Stop at the first quote marker or attribution line and only
 * the typed part is left.
 */
const firstLine = (text) => {
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    // '>' is the quote, "On … wrote:" is Gmail and Apple Mail, '--' is a
    // signature. Any of them means the typed part is over.
    if (line.startsWith('>') || /wrote:\s*$/i.test(line) || /^--\s*$/.test(line)) break
    if (line) return line
  }
  return ''
}

/**
 * What counts as an answer. Anchored at the start of the typed line, so it is
 * the opening of the reply that decides and never a word further in.
 *
 * Wider than "approve" and "reject" because nobody remembers a password to a
 * feature like this: the words that come out of a person's thumbs are "yes",
 * "let them in", "nah". Whatever is added here has to be added to the wording
 * in worker/lib/mail.js and to `SAY_AGAIN` below — a vocabulary the mail does
 * not print is a vocabulary nobody can use.
 */
const VERBS = [
  [
    /^(approve[ds]?|approving|accept(ed)?|allow|admit|let\s+(them|him|her|'?em)\s+in|go\s+ahead|do\s+it|yes|yep|yeah|yup|ok|okay|sure|fine|y)\b/i,
    'approve',
  ],
  [
    // `not(?!\s+sure)` because "not sure" is the one place a reject word means
    // its opposite: hesitation, which must fall through to asking again.
    /^(reject(ed)?|declin(e|ed)|den(y|ied)|refuse|block|keep\s+(them|him|her|'?em)\s+out|no|nope|nah|not(?!\s+sure)|never|n)\b/i,
    'reject',
  ],
]

/** Sent back when the reply was not one of the above. Names them, so it teaches. */
export const SAY_AGAIN = {
  heading: 'Say again?',
  line: 'Nothing was changed. Reply with “approve” or “reject” — only the first word of your reply is read.',
  note: '“yes”, “ok”, “sure” and “let them in” all count as approve. “no”, “nah”, “never” and “keep them out” all count as reject. Case and punctuation do not matter, and the request is still waiting, so a second reply decides it.',
}

/**
 * 'approve' | 'reject' | null. The first word wins and nothing else is looked
 * at: a reply is a human typing on a phone, and a parser that tries to be
 * clever about "no, approve him" is a parser that will one day let the wrong
 * person in. Anything it does not recognise gets asked again, which is the
 * safe half of the ambiguity.
 */
export const readDecision = (text) => {
  const line = firstLine(text)
  return VERBS.find(([re]) => re.test(line))?.[1] ?? null
}

/** Last resort when a client sends HTML and no text part. */
const detag = (html) =>
  String(html ?? '')
    .replace(/<blockquote[\s\S]*$/i, '') // the quoted original, in HTML replies
    .replace(/<br\s*\/?>|<\/(p|div|tr)>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')

/**
 * Take the executable parts out of a stranger's HTML before it is forwarded.
 *
 * Mail clients do most of this already — none of them run a <script> tag. That
 * is a reason to keep the mail readable, not a reason for this Worker to be the
 * thing that hands the payload over: Resend renders what we send, the admin's
 * client is one setting away from being more permissive than assumed, and the
 * whole point of forwarding is that somebody opens it.
 *
 * Deliberately blunt. This is not a sanitiser and must not be mistaken for one
 * — it removes the tags that carry code and the attributes that carry handlers,
 * and leaves the formatting alone. A forward that reformats the mail is worse
 * at being a forward.
 */
export const defang = (html) =>
  String(html ?? '')
    .replace(/<\s*(script|iframe|object|embed|form|base|meta|link)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
    // …and the same tags written without a closing half.
    .replace(/<\s*(script|iframe|object|embed|form|base|meta|link)\b[^>]*>/gi, '')
    // Inline handlers: onclick=, onerror=, quoted or bare.
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    // javascript: in an href or a src.
    .replace(/(href|src|action)\s*=\s*(["']?)\s*javascript:[^"'\s>]*/gi, '$1=$2#')

/**
 * The forwarded message. Their body is passed through under a banner rather
 * than poured into the branded template: a forward that reformats the mail is
 * worse at being a forward, and wrapping attacker-authored HTML in our markup
 * only invites it to break out of it. The banner is escaped and comes first, so
 * an unclosed tag in their half cannot swallow it.
 */
const wrap = ({ from, to, subject, html, text, attachments }) => `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#6a6c6a;padding:12px 14px;background:#f1f1ed;border-radius:10px;">
    <b style="color:#0e0f0c;">Forwarded from ${escapeHtml(to)}</b><br />
    From: ${escapeHtml(from)}<br />
    Subject: ${escapeHtml(subject || '(no subject)')}
    ${
      attachments?.length
        ? `<br />${attachments.length} attachment${
            attachments.length === 1 ? '' : 's'
          } — open it in Resend to download.`
        : ''
    }
  </div>
  <hr style="border:0;border-top:1px solid #e4e4e1;margin:18px 0;" />
  ${
    defang(html) ||
    `<pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(
      text ?? '(empty message)',
    )}</pre>`
  }`

/**
 * Returns a Response. Called only for /api/inbound.
 *
 * Failure codes are chosen for Svix's retry behaviour: a 400 is final (a bad
 * signature will never become good), a 500 is retried with backoff (Resend or
 * the network was briefly unavailable, and the mail is worth another go).
 */
export async function handleInbound(request, env) {
  if (request.method !== 'POST') {
    return new Response('POST only', { status: 405 })
  }
  // SITE_URL among them: a reply can approve somebody, and approving sends a
  // magic link whose redirect_to is built from it. Falling back to this
  // request's own origin would let the Host header decide where a sign-in link
  // lands. See canNotify in worker/access.js.
  if (
    !env.RESEND_WEBHOOK_SECRET || !env.RESEND_API_KEY || !env.ADMIN_EMAIL ||
    !env.MAIL_FROM || !env.SITE_URL
  ) {
    console.error('[inbound] secrets missing — cannot forward')
    return new Response('not configured', { status: 500 })
  }

  // Raw, and read exactly once. request.json() here would make the signature
  // check meaningless.
  const raw = await request.text()
  if (!(await verified(env.RESEND_WEBHOOK_SECRET, request.headers, raw))) {
    console.warn('[inbound] rejected an unsigned or stale request')
    return new Response('bad signature', { status: 400 })
  }

  let event
  try {
    event = JSON.parse(raw)
  } catch {
    return new Response('bad json', { status: 400 })
  }

  // Signed, but not the event we handle. Acknowledge it or Svix retries it
  // forever.
  if (event?.type !== 'email.received' || !event?.data?.email_id) {
    return new Response('ignored', { status: 200 })
  }

  const got = await fetch(`https://api.resend.com/emails/receiving/${event.data.email_id}`, {
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}` },
  })
  if (!got.ok) {
    console.error('[inbound] fetch body', got.status, (await got.text()).slice(0, 300))
    return new Response('could not read the message', { status: 500 })
  }
  const email = await got.json()

  const from = email?.from ?? 'unknown sender'
  const byAdmin = sameMailbox(from, env.ADMIN_EMAIL)

  // ── A reply that decides ──────────────────────────────────────────────
  //
  // Deliberately above the loop guard: this mail IS from the admin, and the
  // guard below exists to stop exactly that being forwarded back.
  const id = replyTag(email?.to)
  if (id) {
    // The id is unguessable and lives only in the admin's mailbox, so this is
    // belt and braces — but a From header costs nothing to check, and a token
    // that leaks (a forwarded thread, a screenshot) should not be enough on its
    // own to let someone into the app. See sameMailbox: the address, compared
    // exactly, never the header it arrived in.
    if (!byAdmin) {
      console.warn('[inbound] a decision address was replied to by somebody else')
      return new Response('ignored', { status: 200 })
    }

    const site = String(env.SITE_URL).replace(/\/$/, '')
    const decision = readDecision(email?.text || detag(email?.html))
    const said = decision ? await decideByReply(env, id, decision, site) : SAY_AGAIN

    // The receipt is the only confirmation there is — nothing in this flow
    // renders a page — so a failure to send it is worth Svix's retry. The
    // retried attempt finds the row already decided and says so, which is still
    // an answer.
    const told = await send(env, {
      to: env.ADMIN_EMAIL,
      subject: `Hisaab — ${said.heading.replace(/\.$/, '')}`,
      html: receipt({ site, ...said }),
    })
    return told
      ? new Response('decided', { status: 200 })
      : new Response('decided, but the receipt did not send', { status: 500 })
  }

  // Loop guard. Forwarding to ADMIN_EMAIL from MAIL_FROM means an out-of-office
  // or a bounce on the admin's side lands straight back in this webhook, and
  // each pass sends another. One comparison ends it.
  if (byAdmin) {
    console.warn('[inbound] refusing to forward mail from the forwarding address')
    return new Response('ignored', { status: 200 })
  }

  const sent = await send(env, {
    to: env.ADMIN_EMAIL,
    // Replying goes to whoever wrote in, not to the address that forwarded it —
    // which is the entire point of doing this rather than reading a dashboard.
    replyTo: from,
    subject: `Fwd: ${email?.subject || '(no subject)'}`,
    html: wrap({
      from,
      to: Array.isArray(email?.to) ? email.to.join(', ') : email?.to ?? '',
      subject: email?.subject,
      html: email?.html,
      text: email?.text,
      attachments: email?.attachments,
    }),
  })

  if (!sent) return new Response('could not forward', { status: 500 })
  return new Response('forwarded', { status: 200 })
}

// ponytail: attachments are named in the banner, not re-attached. Each one is
// a second fetch and a base64 blow-up held in Worker memory, for replies to an
// approval email — which do not have attachments. Pull them through here if
// that ever stops being true.
