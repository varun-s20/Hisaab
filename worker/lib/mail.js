// The three emails the approval queue sends, and the one call that sends them.
//
// Supabase's own SMTP sends the sign-in code, and that is all it can send —
// its templates are bound to auth events. These three are ours: a request
// landing, an approval, a decline. Resend takes them over HTTPS, which is the
// part that matters on Cloudflare, where a Worker cannot open an SMTP socket.
//
// Markup is tables and inline styles, matching supabase/email/*.html, because
// Outlook still renders with Word. The .dk-* classes and the [data-ogsc] block
// are the same dark-mode escape hatches those templates use — see the comments
// there for why both are needed.

const FONT = `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`

/** Anything from a stranger goes through here before it lands in HTML. */
const escapeHtml = (s) =>
  String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )

const HEAD = `
  <style>
    a[x-apple-data-detectors] { color: inherit !important; text-decoration: none !important; }
    @media (prefers-color-scheme: dark) {
      .dk-page { background: #121511 !important; }
      .dk-card { background: #1e211d !important; border-color: #2c302a !important; }
      .dk-text { color: #f3f5f1 !important; }
      .dk-muted { color: #8f938c !important; }
      .dk-rule { border-color: #2c302a !important; }
      .dk-panel { background: #9fe870 !important; }
      .dk-ink { color: #10240a !important; }
      .dk-ink-2 { color: #2a4a14 !important; }
      .dk-keep { background: #e2f6d5 !important; color: #163300 !important; }
    }
    [data-ogsc] .dk-panel, [data-ogsb] .dk-panel { background: #9fe870 !important; }
    [data-ogsc] .dk-ink { color: #10240a !important; }
    [data-ogsc] .dk-ink-2 { color: #2a4a14 !important; }
    [data-ogsc] .dk-keep, [data-ogsb] .dk-keep { background: #e2f6d5 !important; color: #163300 !important; }
    @media (max-width: 480px) { .pad { padding-left: 22px !important; padding-right: 22px !important; } }
  </style>`

/**
 * The green panel, a white card, the footer. `site` is where the logo comes
 * from — the same icon-192.png the app and the installer use, so there is one
 * image to keep current rather than a second copy of the artwork.
 */
const shell = ({ site, preview, heading, sub, card }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="light dark" />
<meta name="supported-color-schemes" content="light dark" />${HEAD}</head>
<body class="dk-page" style="margin:0;padding:0;background:#f1f1ed;-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(preview)}
&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;&#8199;&#65279;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="dk-page" style="background:#f1f1ed;">
<tr><td align="center" style="padding:32px 16px 44px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
  <tr><td class="pad dk-panel" style="background:#9fe870;border-radius:26px;padding:26px 28px 24px;text-align:left;">
    <img src="${site}/icon-192.png" width="52" height="52" alt="Hisaab" style="display:block;width:52px;height:52px;border-radius:13px;border:0;margin-bottom:18px;" />
    <div class="dk-ink" style="font-family:${FONT};font-size:27px;font-weight:700;line-height:1.14;letter-spacing:-0.03em;color:#163300;">${heading}</div>
    <div class="dk-ink-2" style="font-family:${FONT};font-size:13px;font-weight:500;line-height:1.5;color:#2a4a14;margin-top:10px;">${sub}</div>
  </td></tr>
  <tr><td style="height:14px;line-height:14px;font-size:0;">&nbsp;</td></tr>
  <tr><td class="dk-card pad" style="background:#ffffff;border:1px solid #e4e4e1;border-radius:18px;padding:28px;">${card}</td></tr>
  <tr><td class="pad" style="padding:22px 28px 0;text-align:center;">
    <div class="dk-muted" style="font-family:${FONT};font-size:12px;line-height:1.65;color:#6a6c6a;">
      Hisaab reads your screenshots on your own device and keeps only the row &mdash; date, amount, merchant, category.
      <br /><br />&#2361;&#2367;&#2360;&#2366;&#2348; &middot; by Broombuilds
    </div>
  </td></tr>
</table></td></tr></table></body></html>`

/** A button that survives Outlook, which ignores padding on an <a>. */
const button = (href, label, { fill = '#163300', ink = '#ffffff' } = {}) => `
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
    <tr><td align="center" style="background:${fill};border-radius:14px;">
      <a href="${href}" style="display:inline-block;padding:15px 30px;font-family:${FONT};font-size:16px;font-weight:600;color:${ink};text-decoration:none;">${label}</a>
    </td></tr>
  </table>`

const body = (html) =>
  `<div class="dk-text" style="font-family:${FONT};font-size:15px;line-height:1.55;color:#0e0f0c;">${html}</div>`

const fine = (html) =>
  `<div class="dk-rule" style="border-top:1px solid #e4e4e1;margin:20px 0 0;padding-top:16px;">
     <div class="dk-muted" style="font-family:${FONT};font-size:13px;line-height:1.6;color:#6a6c6a;">${html}</div>
   </div>`

// ── The three ────────────────────────────────────────────────────────────

/**
 * To the admin. The reply is the feature: hit Reply, type one word, send. The
 * reply-to address carries the request id, worker/inbound.js reads the first
 * word, and nothing opens a browser.
 *
 * The two links are the fallback, in the fine print rather than as buttons —
 * they are what still works if Resend Inbound is not configured, and tapping
 * one is what the admin was doing before and does not want to do.
 */
export const adminRequest = ({ site, email, asked, approveUrl, rejectUrl }) =>
  shell({
    site,
    preview: `${email} is asking for Hisaab. Reply approve or reject.`,
    heading: 'Someone wants in.',
    sub: 'Reply to this email to decide it.',
    card: `
      ${body(`<b>${escapeHtml(email)}</b>`)}
      <div class="dk-muted" style="font-family:${FONT};font-size:13px;color:#6a6c6a;margin-top:4px;">Asked ${escapeHtml(
        asked,
      )}</div>
      <div class="dk-keep" style="background:#e2f6d5;border-radius:14px;padding:16px 18px;margin-top:20px;font-family:${FONT};font-size:15px;line-height:1.6;color:#163300;">
        Reply <b>approve</b> and they are in.<br />
        Reply <b>reject</b> to turn them down.
      </div>
      ${fine(
        // The vocabulary is printed because it cannot be guessed. Keep this in
        // step with VERBS in worker/inbound.js — words the parser takes but the
        // mail never mentions may as well not exist.
        `Only the <b>first word</b> of your reply is read, so it can be a sentence.
         <b>yes</b>, <b>ok</b>, <b>sure</b> and <b>let them in</b> all mean approve;
         <b>no</b>, <b>nah</b>, <b>never</b> and <b>keep them out</b> all mean reject.
         Anything else changes nothing and asks you again. A one-line receipt comes back either way,
         and the reply works for as long as this request is still waiting.
         <br /><br />If replying is not handy, these still work for 7 days:
         <a href="${approveUrl}" style="color:#163300;font-weight:600;">Approve</a> &middot;
         <a href="${rejectUrl}" style="color:#6a6c6a;">Reject</a>.`,
      )}`,
  })

/**
 * Back to the admin once a reply has been acted on. The reply was the whole
 * interaction — there is no page anywhere in it — so this line is the only
 * confirmation that anything happened, and it has to arrive even when the
 * answer is "that one was already decided".
 */
export const receipt = ({ site, heading, line, note }) =>
  shell({
    site,
    preview: line,
    heading,
    sub: 'From your reply.',
    card: `${body(escapeHtml(line))}${note ? fine(escapeHtml(note)) : ''}`,
  })

/**
 * To the person, on approve. Carries the magic link *and* the code route: the
 * link is the one tap, and on Android Gmail may open it in a browser that is
 * not the installed app, in which case the code they already know how to use
 * is right underneath. See the comment at the top of src/screens/SignIn.jsx.
 *
 * `link` is null when Supabase would not mint one. The account still exists by
 * then, so the mail still goes — it just leads with the code route instead of
 * apologising for a button that isn't there.
 */
export const approved = ({ site, link }) =>
  shell({
    site,
    preview: 'You’re in. Open Hisaab and start logging.',
    heading: 'You’re in.',
    sub: 'Your request for Hisaab was approved.',
    card: link
      ? `${body(
          'Tap once to sign in. The link is good for an hour and works only from this inbox.',
        )}
         <div style="margin-top:22px;">${button(link, 'Open Hisaab')}</div>
         ${fine(
           `If the link opens the wrong browser or has expired, open Hisaab yourself, type this address on the sign-in screen, and use the six-digit code it emails you. That works every time.`,
         )}`
      : `${body(
          `Open Hisaab at <a href="${site}" style="color:#163300;">${escapeHtml(
            site.replace(/^https?:\/\//, ''),
          )}</a>, type this address on the sign-in screen, and use the six-digit code it emails you.`,
        )}
         ${fine('No password to invent — a code is the whole of signing in.')}`,
  })

/** To the person, on reject. Short, final, and no reply address to chase. */
export const declined = ({ site }) =>
  shell({
    site,
    preview: 'About your Hisaab request.',
    heading: 'Not this time.',
    sub: 'About your request for Hisaab.',
    card: `
      ${body(
        'Thanks for asking. Hisaab is invite-only and we’re not opening this one up right now.',
      )}
      ${fine('Nothing has been created and nothing about you has been kept.')}`,
  })

// ── Sending ──────────────────────────────────────────────────────────────

/**
 * Resend, over plain fetch. No SDK: it is one POST, and a dependency in the
 * Worker bundle is a dependency in the cold start.
 *
 * Returns true if it went. Every caller treats false as "carry on" — the row is
 * already written, and an unsendable email must not turn into an error the
 * person asking for access can see.
 */
export async function send(env, { to, subject, html, replyTo }) {
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) {
    console.error('[mail] RESEND_API_KEY / MAIL_FROM are not set — nothing sent')
    return false
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.MAIL_FROM,
        to: [to],
        subject,
        html,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    })
    if (!r.ok) {
      console.error('[mail]', r.status, (await r.text()).slice(0, 300))
      return false
    }
    return true
  } catch (e) {
    console.error('[mail]', e?.message ?? e)
    return false
  }
}
