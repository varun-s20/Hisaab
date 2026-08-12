-- Accounts as a real dimension. Run once, in the Supabase SQL editor, on a
-- database created before this existed. Safe to re-run; it touches no amounts.
--
-- `create table if not exists` in db/schema.sql will not add a column to a
-- table that is already there, and will not widen a unique constraint. This
-- does both, and then repairs the rows an earlier import already wrote.

-- ── 1. Where a transfer landed ─────────────────────────────────────────────
alter table transactions add column if not exists to_account text;

-- A budgeting-app export writes both sides of a transfer into one cell, so
-- rows imported before the split look like `account = 'SBI Bank->Needs'`. Left
-- that way the whole string is its own account: it appears in the picker, in
-- "group by account", and in a balance for an envelope nobody has.
--
-- Split on the first arrow only — an account name may contain a hyphen
-- ("Adjustment-"), but the separator is always '->'.
update transactions
   set account    = btrim(split_part(account, '->', 1)),
       to_account = btrim(split_part(account, '->', 2))
 where account like '%->%';

-- ── 2. A budget can cap an account, not only a category ────────────────────
alter table budgets add column if not exists scope text not null default 'category';

-- Added separately from the column: a CHECK in the ADD COLUMN above would be
-- validated against rows that do not have the default written yet on some
-- Postgres versions.
alter table budgets drop constraint if exists budgets_scope_check;
alter table budgets add constraint budgets_scope_check check (scope in ('category','account'));

-- The old index was unique on (user_id, category). With two scopes sharing the
-- column, an account and a category of the same name would collide — and
-- "Transfers" is plausibly both.
alter table budgets drop constraint if exists budgets_user_id_category_key;
drop index if exists budgets_user_id_category_key;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'budgets_user_id_scope_category_key') then
    alter table budgets add constraint budgets_user_id_scope_category_key
      unique (user_id, scope, category);
  end if;
end $$;

-- ── 3. Check ───────────────────────────────────────────────────────────────
-- Expect zero rows. Anything here still has both sides of a transfer in one
-- cell and did not get split above.
select id, account, to_account
  from transactions
 where account like '%->%';
