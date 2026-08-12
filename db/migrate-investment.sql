-- Adds 'investment' as a transaction type.
--
-- Run this once in the Supabase SQL editor. Until it has run, saving a row as
-- an investment fails with:
--
--   new row for relation "transactions" violates check constraint
--   "transactions_type_check"
--
-- Safe to re-run. Touches no data — an SIP already filed as a transfer stays a
-- transfer until you change it, because guessing which of your transfers were
-- investments is not something a migration should do behind your back.

alter table transactions drop constraint if exists transactions_type_check;

alter table transactions
  add constraint transactions_type_check
  check (type in ('expense', 'income', 'investment', 'transfer', 'refund', 'lent', 'repaid'));
