-- Paisa schema — run this once in the Supabase SQL editor.
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
  type          text not null default 'expense'
                check (type in ('expense','income','transfer','refund','lent','repaid')),

  payee_raw     text not null,           -- exactly as OCR'd
  payee_clean   text,                    -- after merchant map
  category      text,
  subcategory   text,

  method        text,                    -- gpay | phonepe | paytm | card | cash | netbanking
  account       text,                    -- which bank/card, if known

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

-- ── Row level security: nobody sees anyone else's money ───────────────────
-- Migration for a database created before unreadable rows were stored rather
-- than dropped. No-op on a fresh schema.
alter table transactions alter column amount drop not null;

alter table transactions enable row level security;
alter table merchant_map enable row level security;

drop policy if exists "own rows" on transactions;
create policy "own rows" on transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own map" on merchant_map;
create policy "own map" on merchant_map
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
