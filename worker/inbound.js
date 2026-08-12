// Forward mail sent to the brand address into an inbox someone actually reads.
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

/**
 * The forwarded message. Their body is passed through as-is under a banner
 * rather than poured into the branded template: a forward that reformats the
 * mail is worse at being a forward, and wrapping attacker-authored HTML in our
 * markup only invites it to break out of it. The banner is escaped and comes
 * first, so an unclosed tag in their half cannot swallow it.
 */
const wrap = ({ from, to, subject, html, text, attachments }) => `
  <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:13px;line-height:1.6;color:#6a6c6a;padding:12px 14px;background:#f1f1ed;border-radius:10px;">
    <b style="color:#0e0f0c;">Forwarded from ${escapeHtml(to)}</b><br />
    From: ${escapeHtml(from)}<br />
    Subject: ${escapeHtml(subject || '(no subject)')}
    ${attachments?.length ? `<br />${attachments.length} attachment${attachments.length === 1 ? '' : 's'} — open it in Resend to download.` : ''}
  </div>
  <hr style="border:0;border-top:1px solid #e4e4e1;margin:18px 0;" />
  ${html || `<pre style="white-space:pre-wrap;font-family:inherit;">${escapeHtml(text ?? '(empty message)')}</pre>`}`

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
  if (!env.RESEND_WEBHOOK_SECRET || !env.RESEND_API_KEY || !env.ADMIN_EMAIL || !env.MAIL_FROM) {
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

  // Loop guard. Forwarding to ADMIN_EMAIL from MAIL_FROM means an out-of-office
  // or a bounce on the admin's side lands straight back in this webhook, and
  // each pass sends another. One comparison ends it.
  if (String(from).toLowerCase().includes(String(env.ADMIN_EMAIL).toLowerCase())) {
    console.warn('[inbound] refusing to forward mail from the forwarding address')
    return new Response('ignored', { status: 200 })
  }

  const sent = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: env.MAIL_FROM,
      to: [env.ADMIN_EMAIL],
      // Replying goes to whoever wrote in, not to the address that forwarded
      // it — which is the entire point of doing this rather than reading a
      // dashboard.
      reply_to: from,
      subject: `Fwd: ${email?.subject || '(no subject)'}`,
      html: wrap({
        from,
        to: Array.isArray(email?.to) ? email.to.join(', ') : (email?.to ?? ''),
        subject: email?.subject,
        html: email?.html,
        text: email?.text,
        attachments: email?.attachments,
      }),
    }),
  })

  if (!sent.ok) {
    console.error('[inbound] forward', sent.status, (await sent.text()).slice(0, 300))
    return new Response('could not forward', { status: 500 })
  }
  return new Response('forwarded', { status: 200 })
}

// ponytail: attachments are named in the banner, not re-attached. Each one is
// a second fetch and a base64 blow-up held in Worker memory, for replies to an
// approval email — which do not have attachments. Pull them through here if
// that ever stops being true.
