-- Hisaab schema — run this once in the Supabase SQL editor.
-- Safe to re-run: everything is guarded with "if not exists".

-- ── Transactions: one row per payment ──────────────────────────────────────
create table if not exists transactions (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) default auth.uid(),

  txn_ref       text,                    -- UPI reference; dedup key
  txn_date      date not null,
  txn_time      time,

  -- Nullable on purpose: a screenshot whose amount the OCR mangled still has to
  -- be stored, or it vanishes with nothing but a count to show for it. It lands
  -- in "Needs a look" with the raw text attached. Always positive when present.
  amount        numeric(12,2),
  direction     text not null check (direction in ('debit','credit')),
  -- 'investment' is money put away, not spent: it counts in neither spending
  -- nor income and has its own view on Insights. An existing database needs
  -- db/migrate-investment.sql for this list; "if not exists" above will not
  -- widen a constraint on a table that already exists.
  type          text not null default 'expense'
                check (type in ('expense','income','investment','transfer','refund','lent','repaid')),

  payee_raw     text not null,           -- exactly as OCR'd
  payee_clean   text,                    -- after merchant map
  category      text,
  subcategory   text,

  method        text,                    -- gpay | phonepe | paytm | card | cash | netbanking
  account       text,                    -- which bank/card/envelope the money LEFT
  -- Where it landed, on a transfer between two of your own accounts. Null on
  -- everything else, because an expense has no destination you own.
  --
  -- A budgeting-app export writes both sides into one cell ("SBI Bank->Needs"),
  -- and left that way the string is its own account: it shows up in the picker,
  -- in "group by account", and in a balance for an envelope that does not
  -- exist. lib/statement.js splits it on import. An existing database needs
  -- db/migrate-accounts.sql — "if not exists" above will not add a column to a
  -- table that is already there.
  to_account    text,

  source        text not null default 'screenshot'
                check (source in ('screenshot','statement','manual')),
  confidence    numeric(3,2) default 1.0,
  needs_review  boolean default false,
  note          text,

  raw_text      text,                    -- OCR output, for debugging parsers
  created_at    timestamptz default now()
);

-- Dedup: the same UPI ref can only exist once per user.
-- Re-uploading yesterday's screenshots is a silent no-op.
create unique index if not exists txn_ref_unique
  on transactions (user_id, txn_ref)
  where txn_ref is not null;

create index if not exists txn_date_idx on transactions (user_id, txn_date desc);

-- ── Merchant map: the learned asset. The most valuable table here. ─────────
create table if not exists merchant_map (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) default auth.uid(),
  payee_pattern text not null,            -- normalised payee string
  payee_clean   text not null,            -- "Swiggy"
  category      text not null,
  default_type  text default 'expense',
  hit_count     int default 1,
  source        text default 'user',      -- user | ai | seed
  created_at    timestamptz default now(),
  unique (user_id, payee_pattern)
);

-- ── Categories you made yourself ──────────────────────────────────────────
--
-- Only the ones a person invents. The fourteen built-ins live in
-- src/lib/categories.js and are not rows.
--
-- This used to be localStorage, on the reasoning that the category *value* is
-- already written onto every transaction so nothing was lost across devices —
-- only "the picker list, which is a preference". That was wrong, and the bug it
-- caused is exactly what you would predict from it: reinstall the app and your
-- category still appears on every row it was filed under, because the name is
-- on the row, but it is grey and wearing the fallback glyph and cannot be
-- removed, because the colour, the icon and the very fact that it is yours
-- lived on the old device.
--
-- Run this on an existing database; `create table if not exists` above will not
-- add it for you.
create table if not exists categories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid references auth.users(id) default auth.uid(),
  name       text not null check (length(name) between 1 and 28),
  color      text not null default '#E7E7E1',
  icon       text not null default 'other',
  created_at timestamptz default now(),
  unique (user_id, name)
);

-- ── Budgets: the one number the ledger can't derive ───────────────────────
-- One monthly cap per category. The reserved category '*' is the cap for the
-- whole month across every category — a sentinel rather than a second table,
-- because everything else about it (upsert, delete, RLS) is identical.
-- A custom category can never be named '*': addCategory() trims and the picker
-- has no way to produce it.
--
-- `scope` says what the `category` column is naming. Envelope budgeting caps
-- the pocket, not the kind of spending — "₹7,500 into Wants this month" is the
-- decision, and which categories it goes on is the consequence. The column kept
-- its name so nothing that already reads it had to change; only the meaning
-- widened. An existing database needs db/migrate-accounts.sql for `scope` and
-- for the unique index, which has to gain the column or an account and a
-- category of the same name would collide.
create table if not exists budgets (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid references auth.users(id) default auth.uid(),
  scope         text not null default 'category' check (scope in ('category','account')),
  category      text not null,
  amount        numeric(12,2) not null check (amount > 0),
  created_at    timestamptz default now(),
  unique (user_id, scope, category)
);

-- ── Repeats: bills that come round, and what you log every day ────────────
--
-- A saved payment, optionally with a schedule attached.
--
--   rule is null   a tile on Today. Tap it to log the payment. Chai ₹20.
--   rule is set    a bill. It tells you it is due; it never posts by itself.
--
-- One table rather than two because the columns describing the payment are
-- identical and the only difference is whether a person wants reminding.
--
-- An existing database needs db/migrate-templates.sql — "if not exists" above
-- will not add a table to a database that is already there. The app degrades
-- rather than breaking without it: src/lib/backends/supabase.js reads a missing
-- table as "this feature is off" and says which file to run.
create table if not exists templates (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references auth.users(id) default auth.uid(),

  label          text not null check (length(label) between 1 and 40),

  payee          text not null check (length(payee) between 1 and 120),
  -- Nullable: a grocery run repeats at a different price every time, and a tile
  -- that fills in everything but the number is still most of the typing saved.
  amount         numeric(12,2) check (amount is null or amount > 0),
  category       text,
  type           text not null default 'expense'
                 check (type in ('expense','income','investment','transfer','refund','lent','repaid')),
  direction      text not null default 'debit' check (direction in ('debit','credit')),
  method         text,
  account        text,
  to_account     text,
  note           text check (note is null or length(note) <= 140),

  -- { "every": 1, "unit": "month", "monthDay": 5 } and friends. jsonb because
  -- the shape is the app's and only the app reads it. Postgres cannot check it
  -- and is not asked to — src/lib/schedule.js validates every rule on the way
  -- OUT as well as in, because jsonb will store `{"every": 0}` quite happily
  -- and a naive date walk over that never terminates.
  rule           jsonb,

  -- Occurrences are computed from starts_on, never from the previous one, so a
  -- bill on the 31st goes 31 Jan → 28 Feb → 31 Mar rather than ratcheting down
  -- to the 28th and staying there.
  starts_on      date,
  last_posted_on date,

  pinned         boolean not null default false,
  -- "Not a bill". A tombstone naming a payee that must not be suggested again.
  hidden         boolean not null default false,
  source         text not null default 'user' check (source in ('user','detected')),
  created_at     timestamptz default now()
);

create index if not exists templates_user_idx on templates (user_id);

-- ── Access requests: the approval queue ───────────────────────────────────
-- Sign-up is not self-service. Someone who is not a user types their address
-- into the sign-in screen, Supabase refuses to create an account, and the app
-- asks /api/access-request to record it (src/screens/SignIn.jsx).
--
-- The Worker writes this table with the service role, emails you two signed
-- Approve / Reject links, and records the verdict. See worker/access.js and
-- SETUP-APPROVALS.md.
create table if not exists access_requests (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique check (length(email) between 3 and 254),
  created_at timestamptz default now(),
  -- The queue columns. Repeated in db/migrate-access-status.sql, which is what
  -- adds them to a table that already exists — `create table if not exists`
  -- will not add a column to one that is already there.
  status     text not null default 'pending'
             check (status in ('pending', 'approved', 'rejected')),
  decided_at timestamptz,
  notified_at timestamptz
);

alter table access_requests enable row level security;

-- ── No policies. That is the intended state, not an omission. ──
--
-- RLS on with zero policies means the anon key can neither read nor write this
-- table. The service role bypasses RLS, so worker/access.js is the only thing
-- that touches it — which is where the address validation and the two mail rate
-- limits live.
--
-- It used to carry a public INSERT policy so the browser could write the row
-- directly. That made it the one publicly writable table in the schema: anyone
-- with the anon key (it ships in the bundle — it is meant to) could insert
-- without limit. The drop below is therefore load-bearing, and it is here as
-- well as in the migration because SETUP.md tells you re-running this file is
-- safe. Without it, one re-run would silently reopen the hole on a database
-- that had already been migrated.
drop policy if exists "anyone may ask" on access_requests;

-- ── AI usage: one row per person per day ──────────────────────────────────
--
-- api/_auth.js verified that a caller was signed in and then threw away WHICH
-- signed-in person they were, so any approved user could spend GEMINI_API_KEY
-- without limit. A spent quota is not one person's problem: it is Ask and Teach
-- going dark for everybody, including the admin, until the next reset.
--
-- Lives on Hisaab's project only, and is deliberately not in db/byo-setup.sql.
-- A user whose ledger is in their own Supabase still calls Hisaab's AI
-- endpoints as themselves, so their usage is counted here with everyone else's.
create table if not exists ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day     date not null default current_date,
  calls   int  not null default 0,
  primary key (user_id, day)
);

alter table ai_usage enable row level security;

-- No policies, same as access_requests: RLS on with none means neither the anon
-- key nor a signed-in user can read or write this table. Only the service role,
-- from the Worker, touches it.

-- Increment and return, in one statement.
--
-- A read-then-write from the endpoint would let two calls landing together both
-- read the same number and each store it plus one, so a burst would cost far
-- less than it should — which is precisely the case a rate limit exists for.
-- `on conflict … returning` is atomic and costs one round trip.
create or replace function bump_ai_usage(uid uuid)
returns int
language plpgsql
-- Runs as the owner so the function can write a table nothing else may touch.
security definer
-- Pinned: without this, a caller who can create objects in a schema earlier on
-- the search path can shadow a name used below and have it run as the owner.
set search_path = public, pg_temp
as $$
declare n int;
begin
  insert into ai_usage (user_id, day, calls)
       values (uid, current_date, 1)
  on conflict (user_id, day)
    do update set calls = ai_usage.calls + 1
    returning calls into n;
  return n;
end $$;

-- Callable by the service role and nothing else. Postgres grants EXECUTE to
-- public by default, which would let any signed-in caller run it.
revoke execute on function bump_ai_usage(uuid) from public;
revoke execute on function bump_ai_usage(uuid) from anon, authenticated;

-- ── Row level security: nobody sees anyone else's money ───────────────────
-- Migration for a database created before unreadable rows were stored rather
-- than dropped. No-op on a fresh schema.
alter table transactions alter column amount drop not null;

alter table transactions enable row level security;
alter table merchant_map enable row level security;
alter table budgets enable row level security;
alter table categories enable row level security;
-- A template holds a payee, an amount and an account name — the same class of
-- data as a transaction, and it gets the same protection.
alter table templates enable row level security;

drop policy if exists "own templates" on templates;
create policy "own templates" on templates
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own categories" on categories;
create policy "own categories" on categories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own rows" on transactions;
create policy "own rows" on transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own map" on merchant_map;
create policy "own map" on merchant_map
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own budgets" on budgets;
create policy "own budgets" on budgets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
