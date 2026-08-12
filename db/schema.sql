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

-- ── Access requests: the approval queue ───────────────────────────────────
-- Sign-up is not self-service. Someone who is not a user types their address
-- into the sign-in screen, Supabase refuses to create an account, and the app
-- drops a row here instead (src/screens/SignIn.jsx).
--
-- You read it in Table Editor and create the account in Authentication → Users.
-- That is the entire admin tool: the dashboard uses the service role, which
-- bypasses RLS, so there is no admin screen and no second role in the app.
create table if not exists access_requests (
  id         uuid primary key default gen_random_uuid(),
  email      text not null unique check (length(email) between 3 and 254),
  created_at timestamptz default now()
);

alter table access_requests enable row level security;

-- Its RLS lives here rather than in the block below because it is the one table
-- in this schema that is not keyed to a user: the whole point is that the
-- person filling it in does not have an account yet.
--
-- INSERT and nothing else. No select policy means no select — not for anon, not
-- for a signed-in user, not for the person who just wrote the row. An address
-- goes in and only the dashboard can read it back.
--
-- ponytail: a public insert is spammable. The unique index makes repeats a
-- no-op, which covers the accidental case; if a bot ever floods it with random
-- addresses, put Cloudflare Turnstile in front of the ask or move the insert
-- behind a Worker route that rate-limits by IP.
drop policy if exists "anyone may ask" on access_requests;
create policy "anyone may ask" on access_requests
  for insert to anon, authenticated with check (true);

-- ── Row level security: nobody sees anyone else's money ───────────────────
-- Migration for a database created before unreadable rows were stored rather
-- than dropped. No-op on a fresh schema.
alter table transactions alter column amount drop not null;

alter table transactions enable row level security;
alter table merchant_map enable row level security;
alter table budgets enable row level security;

drop policy if exists "own rows" on transactions;
create policy "own rows" on transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own map" on merchant_map;
create policy "own map" on merchant_map
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own budgets" on budgets;
create policy "own budgets" on budgets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
