# What you need to do — approvals by email, and "Get the app"

Everything in the code is done. This is the part only you can do: three accounts
to touch, seven secrets to set, one SQL file to run.

Budget about 30 minutes, most of it waiting on a DNS record.

---

## 0. The short version

| # | Where | What |
|---|---|---|
| 1 | Supabase → SQL Editor | Run `db/migrate-access-status.sql` |
| 2 | resend.com | Sign up, verify your sending domain, make an API key |
| 3 | Terminal | Fill the blanks in `.env.local`, then `npm run push-secrets` |
| 4 | Terminal | `npm run build && npx wrangler deploy` |
| 5 | resend.com | Add the `/api/inbound` webhook, push its secret (§2b) |
| 6 | Your phone | Ask for access from a spare address and approve yourself |

---

## 1. Supabase — run the migration

**Dashboard → SQL Editor → New query.** Paste the whole of
`db/migrate-access-status.sql`, Run.

It adds `status`, `decided_at` and `notified_at` to `access_requests`, and drops
the `anyone may ask` policy — the browser no longer writes that table, the
Worker does.

**Check it worked:** Table Editor → `access_requests` → the three new columns are
there, and under **Policies** the table has **none**. Zero policies with RLS on
is the intended state: unreachable from the anon key, readable only by the
service role.

Leave **Authentication → Sign In / Providers → Email → Allow new users to sign
up** switched **off**. Approving does not go through it — the service role
creates the account directly — so this stays off forever and the app stays shut
to anyone you have not let in.

---

## 2. Resend — so the app can send mail that isn't a login code

Supabase's SMTP only sends what Supabase's own templates trigger. The three new
emails (request, approved, declined) are ours, and Cloudflare Workers cannot
open an SMTP socket, so they go out over an HTTPS API.

1. Sign up at **resend.com**. Free tier is 3,000 emails/month, 100/day — this
   feature will use single digits a week.
2. **Domains → Add Domain.** Use the domain Hisaab is on, or a subdomain like
   `mail.yourdomain.com`.
3. Add the DNS records it gives you (an MX and two or three TXT — SPF, DKIM, and
   usually a DMARC suggestion). Same DNS panel as your site's records.
4. Wait for **Verified**. Usually minutes, occasionally an hour.
5. **API Keys → Create API Key.** Permission **Sending access** is enough. Copy
   it now — Resend shows it once. It starts `re_`.

> **Do not skip the domain.** Resend's shared `onboarding@resend.dev` sender only
> delivers to the address that owns the Resend account. Your approval mail would
> arrive and the applicant's would silently vanish.

Already have SPF/DKIM set up for the Supabase custom SMTP sender (SETUP.md §3d)?
The Resend records are additional, not a replacement. Both can coexist — but if
you already have a DMARC record, leave the one you have rather than adding a
second; two DMARC TXT records at the same name make DMARC fail entirely.

### 2b. Receiving — do this AFTER the first deploy

**Resend Inbound is not a mailbox.** Mail arriving at `hello@yourdomain.com`
triggers a webhook carrying metadata only — not even the body, which has to be
fetched back over the API. With nothing listening, a reply to an approval or a
decline is captured and never seen.

`worker/inbound.js` is that listener: it verifies Resend's signature, fetches
the body, and forwards the message to `ADMIN_EMAIL` with **reply-to set to
whoever wrote in**, so answering from your own inbox reaches them.

This is deliberately out of order — the webhook needs a URL that already
answers, so it comes after step 4:

1. **Resend → Webhooks → Add Webhook.**
2. Endpoint: `https://hisaab.yourdomain.com/api/inbound`
3. Event: **`email.received`**. Nothing else — the route acknowledges other
   event types and does nothing with them, but there is no reason to send them.
4. Copy the **Signing Secret** (starts `whsec_`, and is *not* the API key) into
   `RESEND_WEBHOOK_SECRET` in `.env.local`.
5. `npm run push-secrets` again. No redeploy needed — a secret change takes
   effect on the running Worker.
6. Send a mail to `hello@yourdomain.com` from a phone. It should land in your
   `ADMIN_EMAIL` inbox within seconds, headed *"Forwarded from …"*.

**If it doesn't arrive:** Resend → Webhooks → your endpoint shows every attempt
and its response. `400 bad signature` means the wrong secret is in place — the
overwhelmingly common cause is pasting `re_…` where `whsec_…` belongs, which
`push-secrets` now refuses. `wrangler tail` shows the Worker's side.

**Why the signature matters.** `/api/inbound` is a public URL that causes mail
to be sent. The signature is the only thing in front of it. It is checked
against the **raw** body before parsing, inside a 5-minute window so a captured
request cannot be replayed, and a request that fails sends nothing.
`scripts/test-inbound.mjs` asserts all of that, including that a body edited
after signing is refused and that mail from your own address is never forwarded
back (an out-of-office would otherwise ping-pong forever).

**Attachments are named, not re-attached** — open those in Resend. Replies to an
approval email do not have attachments, and each one is a fetch plus a base64
blow-up in Worker memory.

---

## 3. Cloudflare — the secrets

Fill the blanks at the bottom of `.env.local`, then push them all in one go:

```bash
npm run push-secrets -- --dry   # shows what would go, sends nothing
npm run push-secrets            # sends it
```

The script reads `.env.local`, renames the two Supabase values to the names the
Worker expects, and hands each to `wrangler secret put` **over stdin** — never
as a command argument, which would put your service-role key in your shell
history and in every process list on the machine while it ran. It prints names
and lengths, never values.

What to put in each blank:

| Name | Value | Where it comes from |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | the `service_role` key | Supabase → Project Settings → API Keys |
| `APPROVE_SECRET` | leave blank | generated for you on first run and written back |
| `RESEND_API_KEY` | `re_…` | step 2 |
| `MAIL_FROM` | `Hisaab <hello@yourdomain.com>` | must be on the domain you verified |
| `ADMIN_EMAIL` | your own inbox | where "someone wants in" lands |
| `SITE_URL` | `https://hisaab.yourdomain.com` | **no trailing slash** |

It refuses to push and tells you why if `SITE_URL` has a trailing slash, if
`MAIL_FROM` has no address in it, if the Resend key doesn't start `re_`, or —
the one that would be silent and catastrophic — if you paste the **anon** key
into `SUPABASE_SERVICE_ROLE_KEY` or vice versa. Both are JWTs of similar length
and look identical at a glance; the script decodes the role claim and compares.

`GEMINI_API_KEY`, `SUPABASE_URL` and `SUPABASE_ANON_KEY` go up in the same run,
so this also re-syncs the three the app already needed.

**The dashboard works too** — Workers & Pages → hisaab → Settings → Variables
and Secrets → Add. Use **Secret**, not Text, for anything but `SITE_URL`; Text
values are readable in the dashboard afterwards, Secrets are write-only. The
names must match the table above exactly. The script exists because nine
hand-typed names is eight chances to paste the right value under the wrong one.

> ### The service_role key
>
> This one key can read every row of every user's data and create accounts. It
> bypasses row level security entirely.
>
> - It goes **only** into `wrangler secret put`. Never into `.env.local`, never
>   into anything prefixed `VITE_` — Vite inlines those into the JavaScript
>   every visitor downloads.
> - Never paste it into a chat, an issue, or a screenshot.
> - If it ever does leak: Supabase → Project Settings → API Keys → roll it, then
>   `wrangler secret put` the new one.
>
> `APPROVE_SECRET` matters nearly as much: whoever knows it can mint their own
> Approve links and let themselves in. Same rules.

Then deploy:

```bash
npm run build && wrangler deploy
```

---

## 4. Test it, once, before you tell anyone

Use an address that is **not** yours and has **no** Hisaab account — a second
Gmail, or `you+test@gmail.com` (Gmail treats `+` addresses as the same inbox but
Supabase treats them as different accounts, which is exactly what you want).

1. Open the app signed out, type that address, **Send code**.
2. The screen says *"Hisaab is invite-only. You're on the waiting list — you'll
   usually hear back within 24–72 hours."*
3. Within a few seconds, whatever you set as `ADMIN_EMAIL` gets
   *"Hisaab: … wants in"*.
4. Tap **Approve**. A page opens showing the address. **Nothing has happened
   yet** — that is deliberate.
5. Press **Approve** on that page. It says "Approved."
6. The test address gets *"You're in"* with an **Open Hisaab** button.
7. Tap it. You should land signed in.
8. Clean up: Supabase → Authentication → Users → delete the test user.

**Then test Reject** with a second `+test2` address, so you have seen the decline
mail before a real person does.

### If something doesn't arrive

`wrangler tail` in a terminal, then repeat the step. The logs are explicit:

| Log line | Meaning |
|---|---|
| `[access] secrets missing` | one of the seven isn't set — `wrangler secret list` |
| `[mail] 403 …` | Resend rejected it. Nearly always an unverified domain, or `MAIL_FROM` on a domain you didn't verify |
| `[access] create user 422` | already registered — harmless, it carries on |
| `[access] generate_link 4xx` | they still get the mail, telling them to use the code route. Account exists |
| nothing at all | the Worker wasn't reached. Check `run_worker_first` in `wrangler.jsonc` still lists `/api/*` |

**No mail on a second test with the same address?** Working as intended — one
admin mail per address per 24 hours. Use a different `+tag`.

---

## 5. "Get the app"

Nothing to configure. The button appears on the sign-in screen and under
**More → The app**, and it opens the browser's real install dialog.

What to expect, so a missing button doesn't look like a bug:

| Where | What shows |
|---|---|
| Chrome / Edge on Android, Chrome on desktop | the **Get the app** button |
| iPhone / iPad Safari | a line: tap Share, then Add to Home Screen — iOS has no install prompt and Apple has never offered one |
| Already installed | nothing, in both places |
| Desktop Firefox | nothing — it doesn't support installing web apps |

Chrome only fires the event on a **secure origin with a service worker and a
manifest**, so on `localhost` it works, and on the deployed site it works, but
the button will not appear until the service worker from a *previous* visit has
registered. First-ever load, sometimes second: no button. That is Chrome, not
this code.

---

## 6. What you'll want to know later

**Someone rejected asks again.** Allowed, by your own decision. Their row goes
back to `pending` and you get a fresh mail — subject to the 24-hour cooldown.
They cannot tell rejected from pending; the wording is identical.

**A link expired.** 7 days. Ask them to request access again; that mails you a
new pair.

**You want the queue at a glance.** Supabase → Table Editor →
`access_requests`, filter `status = pending`. Still the only place it can be
read — the app can't, by design.

**Turning the notifications off.** `wrangler secret delete ADMIN_EMAIL`.
Requests are still recorded — you just stop being told, and read the table when
you feel like it. Same if Resend ever goes down mid-request: the row is written
before the mail is attempted, on purpose.

**Costs.** Resend free tier, Cloudflare Workers free tier, Supabase free tier.
This feature adds no billable anything at your volume.
