// The storage backends, and the computation lib/db.js does on top of them.
//
// What earns this file: splitting the ledger across three backends moved real
// logic out of SQL and into JavaScript. `mergeAccount` was an
// `update … where account = ?`, `recategoriseRaws` was three predicated updates
// with a NOT IN, and `listUntaught` was an `.or()` filter. All three are now
// plain code, and plain code that is subtly wrong about a type or a direction
// is wrong about somebody's money on a screen that looks perfectly fine.
//
//   node scripts/test-backends.mjs
//
// Scope, stated honestly: this runs against the local backend. It does NOT
// prove the Supabase backend agrees — that needs a live project or a faithful
// PostgREST fake, and a bad fake would prove less than nothing. The suite takes
// a factory so that second backend can be dropped in when there is one to hand.

import assert from 'node:assert/strict'

// ── A just-enough IndexedDB ────────────────────────────────────────────────
// Hand-stubbed rather than pulled from a package, matching how the other tests
// here stub `fetch`. Requests settle on a microtask and transactions complete
// on a macrotask, which is the ordering the real thing guarantees and the one
// lib/backends/local.js relies on: every put resolves before `oncomplete`.

function installFakeIndexedDB() {
  const databases = new Map()

  const settle = (req, value) => {
    queueMicrotask(() => {
      req.result = value
      req.onsuccess?.()
    })
    return req
  }

  const fail = (req, error) => {
    queueMicrotask(() => {
      req.error = error
      req.onerror?.()
    })
    return req
  }

  const makeStore = (rows) => ({
    getAll: () => settle({}, [...rows.values()]),
    put: (row) => settle({}, (rows.set(row.id, structuredClone(row)), row.id)),
    // `add` refuses an existing key, which is what makes the legacy adoption in
    // lib/backends/local.js safe to run twice.
    add: (row) =>
      rows.has(row.id)
        ? fail({}, new Error('ConstraintError'))
        : settle({}, (rows.set(row.id, structuredClone(row)), row.id)),
    delete: (id) => settle({}, (rows.delete(id), undefined)),
  })

  globalThis.indexedDB = {
    open(name) {
      const req = {}
      const fresh = !databases.has(name)
      if (fresh) databases.set(name, new Map())
      const stores = databases.get(name)

      const db = {
        // Array-like AND iterable, as the real DOMStringList is — local.js
        // spreads it to find out what a legacy database actually holds.
        get objectStoreNames() {
          return Object.assign([...stores.keys()], { contains: (s) => stores.has(s) })
        },
        createObjectStore: (s) => stores.set(s, new Map()),
        close: () => {},
        transaction(names) {
          const list = Array.isArray(names) ? names : [names]
          const tx = { objectStore: (n) => makeStore(stores.get(n)) }
          // A macrotask, so it always lands after the per-request microtasks.
          setTimeout(() => tx.oncomplete?.(), 0)
          void list
          return tx
        },
      }

      queueMicrotask(() => {
        req.result = db
        if (fresh) req.onupgradeneeded?.()
        req.onsuccess?.()
      })
      return req
    },
    deleteDatabase(name) {
      return settle({}, (databases.delete(name), undefined))
    },
  }

  return {
    reset: () => databases.clear(),
    /** What is actually on disk, for the assertions about which database a row
     *  landed in. */
    peek: (name, store) => [...(databases.get(name)?.get(store)?.values() ?? [])],
    names: () => [...databases.keys()],
    seed: (name, store, rows) => {
      if (!databases.has(name)) databases.set(name, new Map())
      const stores = databases.get(name)
      if (!stores.has(store)) stores.set(store, new Map())
      for (const row of rows) stores.get(store).set(row.id, structuredClone(row))
    },
  }
}

const storage = installFakeIndexedDB()
const resetStorage = storage.reset

const { localBackend } = await import('../src/lib/backends/local.js')
const db = await import('../src/lib/db.js')
const { bulkPatch } = await import('../src/lib/entry.js')
const { supabaseBackend } = await import('../src/lib/backends/supabase.js')

// ── Fixtures ───────────────────────────────────────────────────────────────

const txn = (over = {}) => ({
  txn_ref: `ref-${Math.round(Number(over.amount ?? 0) * 100)}-${over.payee_raw ?? 'x'}`,
  txn_date: '2026-08-01',
  amount: 100,
  direction: 'debit',
  type: 'expense',
  payee_raw: 'SWIGGY',
  account: 'HDFC',
  ...over,
})

/** A fresh, empty backend installed as the app's active one. */
async function fresh() {
  resetStorage()
  const backend = localBackend()
  db.installBackend(backend, { kind: 'local' })
  return backend
}

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
    passed += 1
  } catch (e) {
    console.log(`  FAIL ${name}`)
    console.log(`       ${e.message}`)
    failed += 1
  }
}

console.log('\nlocal backend + shared computation\n')

// ── Whose device is it ─────────────────────────────────────────────────────
//
// "This device" is the one backend with no server enforcing whose row is
// whose, so the database name is the whole of the separation. It used to be
// the single string 'hisaab': a second person signing in on the same phone and
// choosing this mode opened the first person's ledger — and could then carry it
// into their own cloud account with one tap of "move to Hisaab cloud".

const A = 'aaaaaaaa-2222-4333-8444-555555555555'
const B = 'bbbbbbbb-2222-4333-8444-555555555555'

await check('two people on one device do not share a ledger', async () => {
  resetStorage()
  const mine = localBackend(A)
  await mine.insertTransactions([{ ...txn({ payee_raw: 'MY CHEMIST' }), id: 'row-a' }])

  const theirs = localBackend(B)
  const rows = await theirs.listAllTransactions({})
  assert.deepEqual(rows, [], 'the second account must open an empty ledger')

  // And the first account still has it — a namespace, not a wipe.
  assert.equal((await mine.listAllTransactions({})).length, 1)
  assert.deepEqual(storage.peek(`hisaab.${A}`, 'transactions').map((r) => r.id), ['row-a'])
})

await check('every store is separated, not only transactions', async () => {
  resetStorage()
  const mine = localBackend(A)
  await mine.upsertMerchantMapping({ payee_pattern: 'MYTHERAPIST', payee_clean: 'Dr S', category: 'Health' })
  await mine.upsertBudget({ category: '*', amount: 20000 })
  await mine.upsertTemplate({ label: 'Rent', payee: 'Landlord', amount: 15000 })
  await mine.upsertCategory({ name: 'Therapy', color: '#fff', icon: 'other' })

  const theirs = localBackend(B)
  assert.deepEqual(await theirs.listMerchantMap(), [])
  assert.deepEqual(await theirs.listBudgets(), [])
  assert.deepEqual(await theirs.listTemplates(), [])
  assert.deepEqual(await theirs.listCategories(), [])
})

await check('a ledger written before this change is carried over, once', async () => {
  resetStorage()
  // What an existing "This device" user has on disk: the unnamespaced database.
  storage.seed('hisaab', 'transactions', [{ ...txn({ payee_raw: 'OLD ROW' }), id: 'legacy-1' }])
  storage.seed('hisaab', 'budgets', [{ id: 'b1', scope: 'category', category: '*', amount: 9000 }])

  const mine = localBackend(A)
  const rows = await mine.listAllTransactions({})
  assert.equal(rows.length, 1, 'the ledger must not vanish under a rename')
  assert.equal(rows[0].payee_raw, 'OLD ROW')
  assert.equal((await mine.listBudgets())[0].amount, 9000, 'every store comes across')

  // Taken away, so the next account to sign in on this device cannot inherit it.
  assert.ok(!storage.names().includes('hisaab'), 'the legacy database must be gone')
  const theirs = localBackend(B)
  assert.deepEqual(await theirs.listAllTransactions({}), [])
})

await check('adoption does not run twice or overwrite what is already there', async () => {
  resetStorage()
  storage.seed('hisaab', 'transactions', [{ ...txn({ payee_raw: 'OLD ROW' }), id: 'legacy-1' }])

  const first = localBackend(A)
  await first.listAllTransactions({})
  await first.updateTransactions(['legacy-1'], { category: 'Health' })

  // A second open of the same account: the legacy database is gone, so there is
  // nothing to re-copy, and the edit above survives.
  const again = localBackend(A)
  const rows = await again.listAllTransactions({})
  assert.equal(rows.length, 1)
  assert.equal(rows[0].category, 'Health', 'a re-run must not restore the old copy over the edit')
})

// ── Writing and dedup ──────────────────────────────────────────────────────

await check('the same reference twice is stored once and counted as a duplicate', async () => {
  await fresh()
  const first = await db.saveTransactions([txn()])
  assert.equal(first.saved, 1)
  assert.equal(first.duplicates, 0)

  const second = await db.saveTransactions([txn()])
  assert.equal(second.saved, 0, 'a repeat upload must store nothing')
  assert.equal(second.duplicates, 1)

  assert.equal((await db.listTransactions({})).length, 1)
})

await check('the same reference twice inside one batch is a duplicate too', async () => {
  await fresh()
  const out = await db.saveTransactions([txn(), txn()])
  assert.equal(out.saved, 1)
  assert.equal(out.duplicates, 1)
})

await check('an amount past numeric(12,2) is stored as null and flagged, not dropped', async () => {
  await fresh()
  // The row must survive: dropping it would leave the user a count and no way
  // to recover the transaction.
  const out = await db.saveTransactions([txn({ amount: 99_999_999_999, raw_text: 'garbled' })])
  assert.equal(out.saved, 1)
  assert.equal(out.unreadable, 1)
  const [row] = await db.listTransactions({})
  assert.equal(row.amount, null)
  assert.equal(row.needs_review, true)
})

// ── Reading ────────────────────────────────────────────────────────────────

await check('rows come back newest first', async () => {
  await fresh()
  await db.saveTransactions([
    txn({ txn_date: '2026-07-01', payee_raw: 'OLD' }),
    txn({ txn_date: '2026-08-09', payee_raw: 'NEW' }),
    txn({ txn_date: '2026-08-02', payee_raw: 'MID' }),
  ])
  const dates = (await db.listTransactions({})).map((r) => r.txn_date)
  assert.deepEqual(dates, ['2026-08-09', '2026-08-02', '2026-07-01'])
})

await check('a date window includes both of its ends', async () => {
  await fresh()
  await db.saveTransactions([
    txn({ txn_date: '2026-07-31', payee_raw: 'BEFORE' }),
    txn({ txn_date: '2026-08-01', payee_raw: 'FIRST' }),
    txn({ txn_date: '2026-08-31', payee_raw: 'LAST' }),
    txn({ txn_date: '2026-09-01', payee_raw: 'AFTER' }),
  ])
  const names = (await db.listTransactions({ from: '2026-08-01', to: '2026-08-31' }))
    .map((r) => r.payee_raw)
    .sort()
  assert.deepEqual(names, ['FIRST', 'LAST'])
})

// ── Balances ───────────────────────────────────────────────────────────────

await check('a transfer leaves one account and arrives in the other', async () => {
  await fresh()
  await db.saveTransactions([
    txn({ amount: 5000, direction: 'credit', type: 'income', account: 'SBI', payee_raw: 'SALARY' }),
    txn({
      amount: 2000,
      direction: 'debit',
      type: 'transfer',
      account: 'SBI',
      to_account: 'Wants',
      payee_raw: 'MOVE',
    }),
    txn({ amount: 300, direction: 'debit', type: 'expense', account: 'Wants', payee_raw: 'CAFE' }),
  ])
  const balances = Object.fromEntries((await db.accountBalances()).map((b) => [b.account, b.balance]))
  assert.equal(balances.SBI, 3000, 'salary in, transfer out')
  assert.equal(balances.Wants, 1700, 'transfer in, coffee out')
})

await check('a credit naming a destination is not counted twice', async () => {
  await fresh()
  // Only a `transfer` means "money arrived at to_account". Counting a credit
  // row on both sides would invent a rupee that never existed.
  await db.saveTransactions([
    txn({
      amount: 400,
      direction: 'credit',
      type: 'refund',
      account: 'HDFC',
      to_account: 'Wants',
      payee_raw: 'AMAZON',
    }),
  ])
  const balances = Object.fromEntries((await db.accountBalances()).map((b) => [b.account, b.balance]))
  assert.equal(balances.HDFC, 400)
  assert.equal(balances.Wants, undefined, 'the destination of a credit is not an arrival')
})

// ── Teaching a merchant ────────────────────────────────────────────────────

await check('teaching a category never flattens an investment back to an expense', async () => {
  await fresh()
  // The bug this guards: a lesson about a merchant's CATEGORY is not new
  // information about a type a person set by hand on a specific row.
  await db.saveTransactions([
    txn({ amount: 1000, payee_raw: 'GROWW', type: 'expense', txn_ref: 'a' }),
    txn({ amount: 2000, payee_raw: 'GROWW', type: 'investment', txn_ref: 'b' }),
  ])
  await db.recategoriseMerchant('GROWW', {
    category: 'Investments',
    payee_clean: 'Groww',
    type: 'expense',
  })
  const rows = await db.listTransactions({})
  const byRef = Object.fromEntries(rows.map((r) => [r.txn_ref, r]))
  assert.equal(byRef.a.type, 'expense')
  assert.equal(byRef.b.type, 'investment', 'a hand-set investment must survive the lesson')
  assert.equal(byRef.b.category, 'Investments', 'but it still learns the category')
  assert.equal(byRef.b.payee_clean, 'Groww')
})

await check('a refund keeps its type when its merchant is taught', async () => {
  await fresh()
  await db.saveTransactions([
    txn({ amount: 500, payee_raw: 'AMAZON', direction: 'credit', type: 'refund', txn_ref: 'r' }),
  ])
  await db.recategoriseMerchant('AMAZON', {
    category: 'Shopping',
    payee_clean: 'Amazon',
    type: 'expense',
  })
  const [row] = await db.listTransactions({})
  assert.equal(row.type, 'refund', 'a ₹500 refund booked as ₹500 spent moves both totals the wrong way')
  assert.equal(row.category, 'Shopping')
})

// ── Merging accounts ───────────────────────────────────────────────────────

await check('merging an account rewrites both sides of a transfer', async () => {
  await fresh()
  await db.saveTransactions([
    txn({ payee_raw: 'A', account: 'SBI Bank', txn_ref: '1' }),
    txn({
      payee_raw: 'B',
      account: 'HDFC',
      to_account: 'SBI Bank',
      type: 'transfer',
      txn_ref: '2',
    }),
    txn({
      payee_raw: 'C',
      account: 'SBI Bank',
      to_account: 'SBI Bank',
      type: 'transfer',
      txn_ref: '3',
    }),
  ])
  await db.mergeAccount('SBI Bank', 'SBI')

  const rows = await db.listTransactions({})
  const byRef = Object.fromEntries(rows.map((r) => [r.txn_ref, r]))
  assert.equal(byRef['1'].account, 'SBI')
  assert.equal(byRef['2'].to_account, 'SBI', 'the destination half must be rewritten too')
  assert.equal(byRef['3'].account, 'SBI')
  assert.equal(byRef['3'].to_account, 'SBI', 'a row naming it on both sides needs both rewritten')

  assert.equal(
    (await db.listAccounts()).includes('SBI Bank'),
    false,
    'the old name must be gone from the picker',
  )
})

// ── The teach queue ────────────────────────────────────────────────────────

await check('only uncategorised, non-transfer merchants are waiting to be taught', async () => {
  await fresh()
  await db.saveTransactions([
    txn({ payee_raw: 'UNKNOWN1', category: null, txn_ref: 'u1' }),
    txn({ payee_raw: 'UNKNOWN1', category: null, txn_ref: 'u2', amount: 200 }),
    txn({ payee_raw: 'UNKNOWN2', category: 'Other', txn_ref: 'u3' }),
    txn({ payee_raw: 'KNOWN', category: 'Groceries', txn_ref: 'k1' }),
    txn({ payee_raw: 'FRIEND', category: null, type: 'transfer', txn_ref: 't1' }),
  ])
  const waiting = await db.listUntaught()
  const names = waiting.map((w) => w.payee_raw).sort()
  assert.deepEqual(names, ['UNKNOWN1', 'UNKNOWN2'])
  assert.equal(waiting.find((w) => w.payee_raw === 'UNKNOWN1').count, 2)
  assert.equal(await db.countUntaught(), 2)
})

// ── Budgets and the merchant map ───────────────────────────────────────────

await check('an account cap and a category cap of the same name are two caps', async () => {
  await fresh()
  await db.setBudget('Rent', 20000, 'category')
  await db.setBudget('Rent', 5000, 'account')
  const budgets = await db.listBudgets()
  assert.equal(budgets.length, 2)
  assert.equal(budgets.find((b) => b.scope === 'category').amount, 20000)
  assert.equal(budgets.find((b) => b.scope === 'account').amount, 5000)

  await db.removeBudget('Rent', 'account')
  const left = await db.listBudgets()
  assert.equal(left.length, 1)
  assert.equal(left[0].scope, 'category')
})

await check('an AI guess never overwrites a correction made by hand', async () => {
  await fresh()
  await db.upsertMerchantMapping({
    payee_pattern: 'SWIGGY',
    payee_clean: 'Swiggy',
    category: 'Food & Dining',
    source: 'user',
    hit_count: 3,
  })
  await db.upsertMerchantMapping(
    { payee_pattern: 'SWIGGY', payee_clean: 'Swiggy Ltd', category: 'Shopping', source: 'ai' },
    { ignoreDuplicates: true },
  )
  const [row] = await db.listMerchantMap()
  assert.equal(row.category, 'Food & Dining', 'the human correction stands')
  assert.equal(row.source, 'user')
})

// ── Wiping, which the "move" half of a backend switch depends on ───────────

await check('clear leaves nothing behind in any table', async () => {
  const backend = await fresh()
  await db.saveTransactions([txn()])
  await db.setBudget('Rent', 20000)
  await db.upsertMerchantMapping({
    payee_pattern: 'X',
    payee_clean: 'X',
    category: 'Other',
    source: 'user',
  })

  await backend.clear()

  assert.equal((await db.listTransactions({})).length, 0)
  assert.equal((await db.listBudgets()).length, 0)
  assert.equal((await db.listMerchantMap()).length, 0)
})

// ── Switching backends ─────────────────────────────────────────────────────
//
// migrate.js is backend-agnostic — both sides are the same fifteen operations —
// so exercising it against the local backend and a conforming in-memory stub
// proves the logic for every pair. The stub also serves as a written-out
// statement of the interface contract.

const { migrate, copyLedger, MIGRATION_ROWS } = await import('../src/lib/migrate.js')

/** A backend in a plain object. `swallow` drops writes silently, which is how
 *  a copy that half-worked is simulated — the case where deleting the original
 *  would destroy the only remaining copy. */
function memoryBackend({ swallow = false } = {}) {
  const rows = []
  const mappings = []
  const budgets = []
  const categories = []
  const templates = []
  const keyOf = (b) => `${b.scope ?? 'category'} ${b.category}`
  return {
    kind: 'memory',
    capabilities: () => ({ toAccount: true, budgetScope: true, templates: true }),
    ready: async () => ({ ok: true, missing: [] }),
    async insertTransactions(incoming) {
      if (swallow) return { saved: [], rejected: incoming.length }
      const saved = incoming.map((r) => ({ ...r, id: r.id ?? crypto.randomUUID() }))
      rows.push(...saved)
      return { saved, rejected: 0 }
    },
    listTransactions: async () => [...rows],
    listAllTransactions: async () => [...rows],
    findExistingRefs: async (refs) =>
      new Set(rows.map((r) => r.txn_ref).filter((r) => refs.includes(r))),
    updateTransactions: async () => [],
    deleteTransactions: async () => 0,
    listNeedsReview: async () => rows.filter((r) => r.needs_review),
    countNeedsReview: async () => rows.filter((r) => r.needs_review).length,
    listMerchantMap: async () => [...mappings],
    async upsertMerchantMapping(row) {
      mappings.push(row)
      return row
    },
    deleteMerchantMapping: async () => {},
    listBudgets: async () => [...budgets],
    async upsertBudget(b) {
      const at = budgets.findIndex((x) => keyOf(x) === keyOf(b))
      if (at >= 0) budgets[at] = b
      else budgets.push(b)
    },
    deleteBudget: async () => {},
    listCategories: async () => [...categories],
    async upsertCategory(c) {
      const at = categories.findIndex((x) => x.name === c.name)
      if (at >= 0) categories[at] = c
      else categories.push(c)
    },
    deleteCategory: async () => {},
    listTemplates: async () => [...templates],
    async upsertTemplate(t) {
      if (swallow) return t
      const next = { ...t, id: t.id ?? crypto.randomUUID() }
      const at = templates.findIndex((x) => x.id === next.id)
      if (at >= 0) templates[at] = next
      else templates.push(next)
      return next
    },
    deleteTemplate: async () => {},
    async clear() {
      rows.length = 0
      mappings.length = 0
      budgets.length = 0
      categories.length = 0
      templates.length = 0
    },
  }
}

/** A local backend loaded with one of everything, ready to be switched away. */
async function loaded() {
  const source = await fresh()
  await db.saveTransactions([
    txn({ payee_raw: 'SWIGGY', txn_ref: 'm1', amount: 480 }),
    txn({ payee_raw: 'UBER', txn_ref: 'm2', amount: 210 }),
  ])
  await db.setBudget('Food & Dining', 8000)
  await db.upsertMerchantMapping({
    payee_pattern: 'SWIGGY',
    payee_clean: 'Swiggy',
    category: 'Food & Dining',
    source: 'user',
  })
  return source
}

console.log('\nswitching backends\n')

await check('a copy carries transactions, merchants and budgets, and leaves the source alone', async () => {
  const source = await loaded()
  const target = memoryBackend()

  const out = await migrate(source, target, { mode: 'copy' })

  assert.equal(out.transactions.copied, 2)
  assert.equal(out.merchants.copied, 1)
  assert.equal(out.budgets.copied, 1)
  assert.equal(out.cleared, false)
  assert.equal(out.verification.ok, true)

  assert.equal((await target.listAllTransactions({})).length, 2)
  assert.equal((await source.listAllTransactions({})).length, 2, 'a copy must not empty the source')
})

await check('user_id is never carried across', async () => {
  const source = await fresh()
  // A row that arrived carrying an owner from the backend it came from. On the
  // destination that uuid belongs to nobody, and RLS would hide the row from
  // its own owner forever.
  await source.insertTransactions([
    { ...txn({ txn_ref: 'own' }), id: crypto.randomUUID(), user_id: 'a-stale-owner' },
  ])
  const target = memoryBackend()
  await copyLedger(source, target)
  const [arrived] = await target.listAllTransactions({})
  assert.equal('user_id' in arrived, false)
})

await check('a move empties the source, but only after the copy verifies', async () => {
  const source = await loaded()
  const target = memoryBackend()

  const out = await migrate(source, target, { mode: 'move' })

  assert.equal(out.cleared, true)
  assert.equal(out.blocked, null)
  assert.equal((await target.listAllTransactions({})).length, 2)
  assert.equal((await source.listAllTransactions({})).length, 0)
})

await check('a copy that did not arrive blocks the delete', async () => {
  const source = await loaded()
  const target = memoryBackend({ swallow: true })

  const out = await migrate(source, target, { mode: 'move' })

  assert.equal(out.cleared, false, 'nothing may be deleted when nothing arrived')
  assert.match(out.blocked, /still in both places/)
  assert.equal(out.verification.ok, false)
  assert.equal(
    (await source.listAllTransactions({})).length,
    2,
    'the only surviving copy must survive',
  )
})

await check('a target that loses the categories blocks the delete too', async () => {
  const source = await loaded()
  await db.upsertCategory({ name: 'Therapy', color: '#C6A8D9', icon: 'health' })

  // Everything arrives except the categories. Verification used to look only at
  // transactions and the merchant map, so this passed — and `migrate` reads a
  // pass as permission to empty the source. Categories cannot be rebuilt by
  // re-importing statements; losing them is losing them.
  const target = memoryBackend()
  target.upsertCategory = async () => {}

  const out = await migrate(source, target, { mode: 'move' })

  assert.equal(out.verification.missingCategories, 1)
  assert.equal(out.verification.ok, false)
  assert.equal(out.cleared, false, 'nothing may be deleted while a category is unaccounted for')
  assert.equal((await source.listCategories()).length, 1)
})

await check('switching twice does not duplicate anything', async () => {
  const source = await loaded()
  const target = memoryBackend()

  await migrate(source, target, { mode: 'copy' })
  const again = await migrate(source, target, { mode: 'copy' })

  assert.equal(again.transactions.copied, 0)
  assert.equal(again.transactions.skipped, 2)
  assert.equal(again.merchants.skipped, 1)
  assert.equal(again.budgets.skipped, 1)
  assert.equal((await target.listAllTransactions({})).length, 2)
})

await check('a ledger at the row ceiling is copied but never moved', async () => {
  const source = await fresh()
  const target = memoryBackend()
  // Reading exactly the ceiling means rows may exist that were never seen, so
  // the original is what proves they existed. Faked by capping the read rather
  // than writing fifty thousand rows.
  const real = source.listAllTransactions
  source.listAllTransactions = async (opts) => {
    const all = await real.call(source, opts)
    return Array.from({ length: MIGRATION_ROWS }, (_, i) => all[i] ?? { ...txn({ txn_ref: `c${i}` }), id: `c${i}` })
  }

  const out = await migrate(source, target, { mode: 'move' })
  assert.equal(out.atCeiling, true)
  assert.equal(out.cleared, false, 'a truncated read must never authorise a delete')
  assert.match(out.blocked, /ceiling/)
})

// ── Categories the user made ───────────────────────────────────────────────
//
// The bug these guard: colour and icon used to live in localStorage while only
// the NAME was written onto transactions. Reinstall, and a category came back
// as grey text wearing the fallback glyph that could not be removed, because
// the two attributes that made it itself were on the old device.

console.log('\ncustom categories\n')

await check('a category keeps its colour and icon in the backend, not the device', async () => {
  const backend = await fresh()
  await db.upsertCategory({ name: 'Therapy', color: '#C6A8D9', icon: 'health' })

  // A different device is a different cache, so read straight from the store.
  const [stored] = await backend.listCategories()
  assert.equal(stored.name, 'Therapy')
  assert.equal(stored.color, '#C6A8D9', 'the colour has to survive the trip')
  assert.equal(stored.icon, 'health', 'and so does the glyph, or it comes back as dots')
})

await check('saving the same category twice edits it rather than duplicating it', async () => {
  const backend = await fresh()
  await db.upsertCategory({ name: 'Pets', color: '#FFC091', icon: 'other' })
  await db.upsertCategory({ name: 'Pets', color: '#9FE870', icon: 'groceries' })

  const all = await backend.listCategories()
  assert.equal(all.length, 1, 'unique (user_id, name) — the name is the key')
  assert.equal(all[0].color, '#9FE870')
  assert.equal(all[0].icon, 'groceries')
})

await check('removing a category leaves the transactions filed under it alone', async () => {
  await fresh()
  await db.upsertCategory({ name: 'Pets', color: '#FFC091', icon: 'other' })
  await db.saveTransactions([txn({ payee_raw: 'VET', category: 'Pets', txn_ref: 'p1' })])

  await db.deleteCategory('Pets')

  const [row] = await db.listTransactions({})
  assert.equal(row.category, 'Pets', 'the row keeps its text; only the picker forgets')
  assert.equal((await db.listCategories()).length, 0)
})

await check('categories travel with a backend switch', async () => {
  const source = await fresh()
  await db.upsertCategory({ name: 'Therapy', color: '#C6A8D9', icon: 'health' })
  const target = memoryBackend()

  const out = await migrate(source, target, { mode: 'copy' })

  assert.equal(out.categories.copied, 1)
  const [arrived] = await target.listCategories()
  assert.equal(arrived.color, '#C6A8D9')
  assert.equal(arrived.icon, 'health')
  assert.equal('user_id' in arrived, false)
})

// ── Backup and restore ─────────────────────────────────────────────────────
//
// The file is the only copy that exists when someone keeps their ledger on the
// device, so a backup that cannot be put back is not a backup.

const { backup, backupProblem, restore } = await import('../src/lib/export.js')

console.log('\nbackup and restore\n')

await check('a backup carries every table, not just the transactions', async () => {
  await loaded()
  await db.upsertCategory({ name: 'Therapy', color: '#C6A8D9', icon: 'health' })

  const file = await backup()
  assert.equal(file.transactions.length, 2)
  assert.equal(file.merchants.length, 1)
  assert.equal(file.budgets.length, 1)
  assert.equal(file.categories.length, 1)
  assert.equal(backupProblem(file), null)
})

await check('a backup restores onto an empty ledger, whole', async () => {
  await loaded()
  await db.upsertCategory({ name: 'Therapy', color: '#C6A8D9', icon: 'health' })
  const file = await backup()

  // A new device: nothing here at all.
  await fresh()
  assert.equal((await db.listTransactions({})).length, 0)

  await restore(file)

  assert.equal((await db.listTransactions({})).length, 2)
  assert.equal((await db.listBudgets()).length, 1)
  assert.equal((await db.listMerchantMap()).length, 1)
  const [category] = await db.listCategories()
  assert.equal(category.color, '#C6A8D9', 'the colour is the half that used to go missing')
  assert.equal(category.icon, 'health')
})

await check('restoring onto a working ledger adds and never removes', async () => {
  await loaded()
  const file = await backup()

  await fresh()
  // Work done since that file was written. Restoring an old backup must not
  // read as "throw away this quarter".
  await db.saveTransactions([txn({ payee_raw: 'NEWER', txn_ref: 'later', amount: 999 })])

  await restore(file)

  const refs = (await db.listTransactions({})).map((r) => r.txn_ref).sort()
  assert.deepEqual(refs, ['later', 'm1', 'm2'])
})

await check('restoring the same file twice changes nothing the second time', async () => {
  await loaded()
  const file = await backup()
  await fresh()

  await restore(file)
  const second = await restore(file)

  assert.equal(second.transactions.copied, 0)
  assert.equal(second.transactions.skipped, 2)
  assert.equal((await db.listTransactions({})).length, 2)
})

await check('a file that is not a backup is refused before it touches anything', async () => {
  await loaded()
  await assert.rejects(() => restore({ hello: 'world' }), /not a Hisaab backup/)
  await assert.rejects(() => restore({ hisaab: 99, transactions: [] }), /different version/)
  // The ledger is untouched by either refusal.
  assert.equal((await db.listTransactions({})).length, 2)
})

// ── What someone pastes during setup ───────────────────────────────────────
//
// The service_role check is the one here that matters. That key bypasses row
// level security completely, so a copy of it in localStorage would hand every
// script on the page unrestricted access to the user's whole database — not
// just their ledger. It is one row above the right key on the same dashboard
// page, which is exactly how it gets pasted by accident.

const { keyProblem, resolveUrl, urlProblem, byoEmailFor, deriveByoPassword } = await import(
  '../src/lib/backend.js'
)

/** A JWT-shaped key carrying one role claim. Signature is irrelevant — this
 *  only has to tell two of the user's own keys apart. */
const legacyKey = (role) =>
  `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify({ role })).toString('base64url')}.sig`

console.log('\nsetup input\n')

await check('a service_role key is refused, and says why', async () => {
  const problem = keyProblem(legacyKey('service_role'))
  assert.match(problem, /service_role/)
  assert.match(problem, /never leave your dashboard/)
})

await check('a secret key in the new format is refused too', async () => {
  assert.match(keyProblem('sb_secret_abcdefghijklmnop'), /secret key/)
})

await check('both anon key formats are accepted', async () => {
  assert.equal(keyProblem(legacyKey('anon')), null)
  assert.equal(keyProblem('sb_publishable_abcdefghijklmnop'), null)
})

await check('junk in the key field is refused rather than tried', async () => {
  assert.match(keyProblem('hunter2'), /does not look like/)
  assert.match(keyProblem(''), /Paste the anon public key/)
})

await check('a project ID becomes the project URL', async () => {
  assert.equal(resolveUrl('abcdefghijklmnopqrst'), 'https://abcdefghijklmnopqrst.supabase.co')
  assert.equal(urlProblem('abcdefghijklmnopqrst'), null)
})

await check('a pasted URL still works, and a trailing slash is trimmed', async () => {
  assert.equal(resolveUrl('https://abcdefgh.supabase.co/'), 'https://abcdefgh.supabase.co')
  assert.equal(urlProblem('https://abcdefgh.supabase.co'), null)
})

await check('a self-hosted instance over http is refused unless it is loopback', async () => {
  // The anon key and the derived password are sent to this host.
  assert.match(urlProblem('http://my-nas.local'), /Use https/)
  assert.equal(urlProblem('http://localhost:54321'), null)
})

await check('a host the browser will not let us reach is refused here, not later', async () => {
  // connect-src in index.html allows supabase.co and loopback. A custom domain
  // passed this check, connected "successfully", and then failed on the first
  // real request with an error that reads as the project being down.
  assert.match(urlProblem('https://db.mycompany.com'), /supabase\.co/)
  assert.equal(urlProblem('https://abcdefgh.supabase.co'), null)
  assert.equal(urlProblem('http://127.0.0.1:54321'), null)
})

// ── The credential Hisaab keeps in their project ───────────────────────────

const UID = '11111111-2222-4333-8444-555555555555'

await check('rotating the anon key does not change the password', async () => {
  // The bug this exists to prevent: keyed on the anon key, pressing "Disable
  // JWT-based API keys" — a button on the very page they copied it from —
  // would change the password out from under an account that already exists.
  // Sign-in then fails, sign-up fails because the account is there, and they
  // are locked out of their own ledger with sign-ups switched off.
  const before = await deriveByoPassword(UID, 'https://abcdefgh.supabase.co')
  const after = await deriveByoPassword(UID, 'https://abcdefgh.supabase.co')
  assert.equal(before, after)
})

await check('the same project reached three ways yields one password', async () => {
  // A project ID, the URL it expands to, and that URL with a trailing slash are
  // the same project. Three passwords for one account would be three lockouts.
  const [fromRef, fromUrl, fromSlash] = await Promise.all([
    deriveByoPassword(UID, 'abcdefghijklmnopqrst'),
    deriveByoPassword(UID, 'https://abcdefghijklmnopqrst.supabase.co'),
    deriveByoPassword(UID, 'https://ABCDEFGHIJKLMNOPQRST.supabase.co/'),
  ])
  assert.equal(fromRef, fromUrl)
  assert.equal(fromRef, fromSlash)
})

await check('two projects, and two users, get different passwords', async () => {
  const mine = await deriveByoPassword(UID, 'https://aaaaaaaa.supabase.co')
  const otherProject = await deriveByoPassword(UID, 'https://bbbbbbbb.supabase.co')
  const otherUser = await deriveByoPassword('99999999-2222-4333-8444-555555555555', 'https://aaaaaaaa.supabase.co')
  assert.notEqual(mine, otherProject)
  assert.notEqual(mine, otherUser)
  assert.ok(mine.length >= 40, 'a 256-bit key, base64url encoded')
})

await check('the account Hisaab keeps in their project is not their own address', async () => {
  // Their real address would look like a personal login they could reset from
  // the dashboard, and a reset would lock the app out of their own data.
  const email = byoEmailFor('11111111-2222-4333-8444-555555555555')
  assert.match(email, /^hisaab\+/)
  assert.doesNotMatch(email, /@gmail|@example\.com$/)
})

// ── Repeats: tiles and bills ───────────────────────────────────────────────
//
// What earns this: a template WRITES A PAYMENT. The validation lives in
// lib/db.js rather than in the sheet precisely because the local backend has no
// CHECK constraints to fall back on — Postgres refuses an empty label and a
// negative amount, IndexedDB will store anything at all, and a switch between
// the two has to carry rows both of them accept.

console.log('\nrepeats\n')

await check('a tile is stored, listed and deleted', async () => {
  await fresh()
  const saved = await db.saveTemplate({ label: 'Chai', payee: 'Chai stall', amount: 20, category: 'Food' })
  assert.ok(saved.id, 'a stored template needs an id')

  const [stored] = await db.listTemplates()
  assert.equal(stored.label, 'Chai')
  assert.equal(Number(stored.amount), 20)
  assert.equal(stored.rule, null, 'a tile has no schedule')

  await db.removeTemplate(stored.id)
  assert.deepEqual(await db.listTemplates(), [])
})

await check('editing a repeat changes it rather than adding a second', async () => {
  await fresh()
  const saved = await db.saveTemplate({ label: 'Chai', payee: 'Chai stall', amount: 20 })
  await db.saveTemplate({ id: saved.id, label: 'Chai', payee: 'Chai stall', amount: 25 })

  const all = await db.listTemplates()
  assert.equal(all.length, 1)
  assert.equal(Number(all[0].amount), 25)
})

await check('junk is refused before it reaches either backend', async () => {
  await fresh()
  const bad = [
    [{ payee: 'x' }, /name is needed/],
    [{ label: 'x' }, /paid to is needed/],
    [{ label: 'x'.repeat(41), payee: 'y' }, /too long/],
    [{ label: 'x', payee: 'y', amount: -5 }, /not a usable figure/],
    [{ label: 'x', payee: 'y', amount: 0 }, /not a usable figure/],
    [{ label: 'x', payee: 'y', amount: 1e12 }, /not a usable figure/],
    [{ label: 'x', payee: 'y', type: 'bribe' }, /kind of payment/],
    [{ label: 'x', payee: 'y', rule: { every: 0, unit: 'day' } }, /Repeat every/],
    [{ label: 'x', payee: 'y', rule: { every: 1, unit: 'fortnight' } }, /unknown cadence/],
  ]
  for (const [row, message] of bad) {
    await assert.rejects(() => db.saveTemplate(row), message, JSON.stringify(row))
  }
  assert.deepEqual(await db.listTemplates(), [], 'nothing invalid may reach the store')
})

await check('a form-only field never reaches the row', async () => {
  await fresh()
  // PostgREST answers 42703 for an unknown column, which on screen is
  // indistinguishable from the migration not having been run.
  await db.saveTemplate({
    label: 'Chai', payee: 'Chai stall', amount: 20, busy: true, isNew: true, unit: 'none', every: 1,
  })
  const [stored] = await db.listTemplates()
  for (const key of ['busy', 'isNew', 'unit', 'every', 'weekday', 'monthDay']) {
    assert.ok(!(key in stored), `${key} must not be stored`)
  }
})

await check('only a transfer keeps a destination', async () => {
  await fresh()
  await db.saveTemplate({ label: 'Rent', payee: 'Landlord', amount: 1, type: 'expense', to_account: 'Wants' })
  const [stored] = await db.listTemplates()
  assert.equal(stored.to_account, null, 'an expense has no destination you own')
})

await check('tapping a tile writes a payment, and twice writes two', async () => {
  await fresh()
  const tile = await db.saveTemplate({ label: 'Chai', payee: 'Chai stall', amount: 20, category: 'Food' })

  await db.postTemplate(tile)
  await db.postTemplate(tile)

  const rows = await db.listTransactions({ limit: 10 })
  // The bug this guards: synthRef keys a timeless manual row on
  // date+amount+payee alone, so without the clock stamp the second chai of the
  // day is silently swallowed as a duplicate of the first.
  assert.equal(rows.length, 2, 'a second chai is a second payment')
  assert.equal(rows[0].payee_clean, 'Chai stall')
  assert.equal(rows[0].source, 'manual')
  assert.ok(rows[0].txn_time, 'a tapped tile carries the moment it was tapped')
})

await check('confirming a bill posts it once and moves it on', async () => {
  await fresh()
  const bill = await db.saveTemplate({
    label: 'Rent',
    payee: 'Landlord',
    amount: 18000,
    rule: { every: 1, unit: 'month', monthDay: 5 },
    starts_on: '2026-03-05',
  })

  await db.postTemplate(bill, { on: '2026-03-05' })
  const [after] = await db.listTemplates()
  assert.equal(after.last_posted_on, '2026-03-05', 'the bill has to move on')

  // Confirming the same occurrence again must not book a second rent. A bill
  // posts against a date and carries no clock, so the reference collides.
  await db.postTemplate(after, { on: '2026-03-05' })
  const rows = await db.listTransactions({ from: '2026-03-01', to: '2026-03-31', limit: 10 })
  assert.equal(rows.length, 1, 'one occurrence is one payment')
})

await check('back-filling a missed occurrence never rewinds the schedule', async () => {
  await fresh()
  const bill = await db.saveTemplate({
    label: 'Rent',
    payee: 'Landlord',
    amount: 18000,
    rule: { every: 1, unit: 'month', monthDay: 5 },
    starts_on: '2026-01-05',
    last_posted_on: '2026-03-05',
  })
  await db.postTemplate(bill, { on: '2026-02-05' })
  const [after] = await db.listTemplates()
  assert.equal(after.last_posted_on, '2026-03-05', 'a back-fill must not offer March all over again')
})

await check('a repeat with no agreed amount posts the one it is given', async () => {
  await fresh()
  await db.saveTemplate({ label: 'Blinkit', payee: 'Blinkit', amount: '' })
  const [stored] = await db.listTemplates()
  assert.equal(stored.amount, null, 'no agreed price is stored as none')

  await db.postTemplate(stored, { amount: 615 })
  const [row] = await db.listTransactions({ limit: 5 })
  assert.equal(Number(row.amount), 615)
})

await check('repeats travel with a backend switch', async () => {
  const source = await fresh()
  await db.saveTemplate({ label: 'Chai', payee: 'Chai stall', amount: 20 })
  await db.saveTemplate({
    label: 'Rent',
    payee: 'Landlord',
    amount: 18000,
    rule: { every: 1, unit: 'month', monthDay: 5 },
    starts_on: '2026-03-05',
  })

  const target = memoryBackend()
  const out = await migrate(source, target, { mode: 'copy' })

  assert.equal(out.templates.copied, 2)
  const carried = await target.listTemplates()
  assert.equal(carried.length, 2)
  const rent = carried.find((t) => t.label === 'Rent')
  // The rule is the whole feature. A copy that drops it leaves a bill that
  // never comes due again and says nothing about it.
  assert.deepEqual(rent.rule, { every: 1, unit: 'month', monthDay: 5 })
  assert.equal(rent.starts_on, '2026-03-05')
})

await check('a switch will not delete repeats it could not carry', async () => {
  const source = await fresh()
  await db.saveTransactions([txn({ payee_raw: 'SWIGGY', txn_ref: 'keep-me', amount: 480 })])
  await db.saveTemplate({ label: 'Rent', payee: 'Landlord', amount: 18000 })

  // A destination that predates db/migrate-templates.sql, modelled the way the
  // real one behaves: it CLAIMS the table is there and only fails on contact.
  // The Supabase backend starts optimistic and learns from a failed read, so a
  // capability check alone never sees this coming.
  const unmigrated = {
    ...memoryBackend(),
    listTemplates: async () => [],
    upsertTemplate: async () => {
      throw new Error('this database has no templates table')
    },
  }

  const out = await migrate(source, unmigrated, { mode: 'move' })
  // Everything else still made it: a feature that cannot be carried must not
  // abort a migration halfway and leave the user with two half ledgers.
  assert.equal(out.transactions.copied, 1, 'the transactions still have to arrive')
  assert.equal(out.templates.copied, 0)
  assert.equal(out.verification.ok, false, 'a repeat that did not arrive is a failed copy')
  assert.equal(out.cleared, false, 'nothing may be deleted that did not arrive')
  assert.ok(out.blocked)
  assert.equal((await source.listTemplates()).length, 1, 'still where it was')
})

await check('deleting the last row naming an account retires the account', async () => {
  await fresh()
  const { rows } = await db.saveTransactions([
    txn({ payee_raw: 'AMAZON', txn_ref: 'gone', amount: 999, account: 'HDFC card', method: 'card' }),
    txn({ payee_raw: 'SWIGGY', txn_ref: 'stays', amount: 480, account: 'SBI', method: 'gpay' }),
  ])
  assert.deepEqual(await db.listAccounts(), ['HDFC card', 'SBI'])

  // Both lists are derived from the rows and cached, so a delete has to clear
  // them exactly as a write does. Undoing an import is the case that matters:
  // it is how a pile of account names arrives, and undoing it used to leave
  // every one of them in the pickers and in what Ask sends to the model.
  await db.deleteTransactions([rows.find((r) => r.txn_ref === 'gone').id])
  assert.deepEqual(await db.listAccounts(), ['SBI'])
  assert.deepEqual(await db.listMethods(), ['gpay'])

  await db.deleteTransaction(rows.find((r) => r.txn_ref === 'stays').id)
  assert.deepEqual(await db.listAccounts(), [])
})

// ── Editing many rows at once ──────────────────────────────────────────────
//
// The Ledger can select a month of rows and recategorise the lot. One call, one
// round trip — and one place where the derived account and method lists have to
// be dropped, or the pickers keep offering a bank nothing is filed under any
// more.

// ── The Supabase backend's URL ceiling ─────────────────────────────────────
//
// PostgREST takes `id=in.(…)` in the query string, and a UUID is 36 characters.
// A few hundred of them is a URL long enough to be answered 414 instead of
// obeyed. findExistingRefs and updateTransactions both chunk for this; delete
// did not, and it is reachable with a whole month selected in the Ledger or by
// undoing a statement import.

function recordingClient({ vanished = [] } = {}) {
  const calls = []
  const settled = (value) => ({ then: (resolve) => resolve(value) })
  const gone = new Set(vanished)
  const client = {
    from() {
      const state = { ids: [] }
      const builder = {
        delete() {
          state.op = 'delete'
          return builder
        },
        update(patch) {
          state.op = 'update'
          state.patch = patch
          return builder
        },
        in(col, values) {
          state.ids = values
          calls.push({ op: state.op, count: values.length })
          return Object.assign(settled({ data: [], error: null }), builder)
        },
        // PostgREST answers a delete carrying `select` with the rows it actually
        // removed — which is not the same list as the one asked for: RLS scopes
        // the statement to the caller, and a row already gone matches nothing
        // and is not an error.
        select: () =>
          settled({ data: state.ids.filter((id) => !gone.has(id)).map((id) => ({ id })), error: null }),
      }
      return builder
    },
  }
  return { calls, client }
}

await check('deleting a month of rows is chunked below the URL ceiling', async () => {
  const { calls, client } = recordingClient()
  const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`)
  const n = await supabaseBackend(client).deleteTransactions(ids)

  assert.equal(n, 250, 'every id has to be reported as dealt with')
  assert.ok(calls.length > 1, 'a single request would be the 414')
  assert.equal(calls.reduce((s, c) => s + c.count, 0), 250, 'and every id has to be sent')
  for (const c of calls) assert.ok(c.count <= 100, `chunk of ${c.count} is over the ceiling`)
})

await check('a delete reports what went, not what was asked for', async () => {
  // Undoing an import says "Removed N rows". Counting the request rather than
  // the answer, N was the size of the batch — including rows somebody had
  // already deleted by hand, which this undo did not remove.
  const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`)
  const { client } = recordingClient({ vanished: ['id-3', 'id-7', 'id-180'] })
  assert.equal(await supabaseBackend(client).deleteTransactions(ids), 247)
})

await check('editing a month of rows is chunked the same way', async () => {
  const { calls, client } = recordingClient()
  const ids = Array.from({ length: 250 }, (_, i) => `id-${i}`)
  await supabaseBackend(client).updateTransactions(ids, { category: 'Eating out' })
  assert.equal(calls.reduce((s, c) => s + c.count, 0), 250)
  for (const c of calls) assert.ok(c.count <= 100)
})

await check('nothing selected sends no request at all', async () => {
  const { calls, client } = recordingClient()
  const backend = supabaseBackend(client)
  assert.equal(await backend.deleteTransactions([]), 0)
  assert.deepEqual(await backend.updateTransactions([], { category: 'x' }), [])
  assert.equal(calls.length, 0)
})

await check('a bulk patch carries only the fields that were set', () => {
  assert.deepEqual(bulkPatch({ category: '', type: '', direction: '', method: '', account: '' }), {})
  assert.deepEqual(bulkPatch({ account: 'SBI' }), { account: 'SBI' })
})

await check('setting a kind of payment sets its direction with it', () => {
  // The trap this exists to close: retyping ten rows as refunds and leaving
  // them `debit`. spendTotal would stop counting them, accountBalances would
  // keep taking the money OUT of the account, and the row would still render
  // with a minus. Wrong in three places, flagged in none.
  assert.deepEqual(bulkPatch({ type: 'refund' }), {
    type: 'refund',
    direction: 'credit',
    to_account: null,
  })
  assert.deepEqual(bulkPatch({ type: 'income' }), {
    type: 'income',
    direction: 'credit',
    to_account: null,
  })
  assert.deepEqual(bulkPatch({ type: 'expense' }), {
    type: 'expense',
    direction: 'debit',
    to_account: null,
  })
})

await check('a direction set by hand outranks the one the type implies', () => {
  // A refund onto a credit card really is money out of the card. Setting both
  // has to mean both.
  assert.deepEqual(bulkPatch({ type: 'refund', direction: 'debit' }), {
    type: 'refund',
    direction: 'debit',
    to_account: null,
  })
})

await check('a row that stops being a transfer loses its destination', () => {
  // accountBalances only reads to_account on a transfer, so a stale one is
  // inert — right up until someone types the row back to a transfer and an
  // envelope is credited by a payment that no longer goes there.
  assert.deepEqual(bulkPatch({ type: 'expense' }).to_account, null)
  assert.equal('to_account' in bulkPatch({ type: 'transfer' }), false)
  assert.equal('to_account' in bulkPatch({ account: 'SBI' }), false)
})

await check('choosing a category by hand is not a guess to be reviewed', () => {
  assert.equal(bulkPatch({ category: 'Eating out' }).needs_review, false)
  assert.equal('needs_review' in bulkPatch({ account: 'SBI' }), false)
})

await check('one patch reaches every row it names and no others', async () => {
  await fresh()
  const { rows } = await db.saveTransactions([
    txn({ payee_raw: 'SWIGGY', txn_ref: 'a', amount: 400, category: 'Other' }),
    txn({ payee_raw: 'SWIGGY', txn_ref: 'b', amount: 520, category: 'Other' }),
    txn({ payee_raw: 'BLINKIT', txn_ref: 'c', amount: 900, category: 'Other' }),
  ])
  const swiggy = rows.filter((r) => r.payee_raw === 'SWIGGY').map((r) => r.id)

  const updated = await db.updateTransactions(swiggy, { category: 'Eating out' })
  assert.equal(updated.length, 2)

  const after = await db.listTransactions({})
  const byRef = Object.fromEntries(after.map((r) => [r.txn_ref, r.category]))
  assert.deepEqual(byRef, { a: 'Eating out', b: 'Eating out', c: 'Other' })
})

await check('a bulk edit clears the account and method lists it invalidated', async () => {
  await fresh()
  const { rows } = await db.saveTransactions([
    txn({ payee_raw: 'ONE', txn_ref: 'one', account: 'HDFC card', method: 'card' }),
    txn({ payee_raw: 'TWO', txn_ref: 'two', account: 'HDFC card', method: 'card' }),
  ])
  // Read first, so the caches are warm and a stale answer is possible.
  assert.deepEqual(await db.listAccounts(), ['HDFC card'])
  assert.deepEqual(await db.listMethods(), ['card'])

  await db.updateTransactions(rows.map((r) => r.id), { account: 'SBI', method: 'gpay' })
  assert.deepEqual(await db.listAccounts(), ['SBI'])
  assert.deepEqual(await db.listMethods(), ['gpay'])
})

await check('selecting nothing writes nothing', async () => {
  await fresh()
  await db.saveTransactions([txn({ payee_raw: 'SWIGGY', category: 'Other' })])
  assert.deepEqual(await db.updateTransactions([], { category: 'Eating out' }), [])
  const [row] = await db.listTransactions({})
  assert.equal(row.category, 'Other', 'an empty selection must not touch the ledger')
})

await check('editing one row still goes through the same path', async () => {
  await fresh()
  const { rows } = await db.saveTransactions([txn({ payee_raw: 'SWIGGY', account: 'HDFC card' })])
  assert.deepEqual(await db.listAccounts(), ['HDFC card'])
  const row = await db.updateTransaction(rows[0].id, { account: 'SBI' })
  assert.equal(row.account, 'SBI')
  assert.deepEqual(await db.listAccounts(), ['SBI'])
})

await check('a bill with no agreed amount does not advance on an empty write', async () => {
  await fresh()
  const bill = await db.saveTemplate({
    label: 'Maid',
    payee: 'Maid',
    amount: '', // "leave empty to be asked each time"
    rule: { every: 1, unit: 'month', monthDay: 5 },
    starts_on: '2026-03-05',
  })
  assert.equal(bill.amount, null)

  // Posting it with nothing to post writes no row. The bug: `!result.rejected`
  // read that as success, stamped last_posted_on, and the occurrence left the
  // due list having never been recorded anywhere.
  const result = await db.postTemplate(bill, { on: '2026-03-05' })
  assert.equal(result.saved, 0)
  assert.equal((await db.listTransactions({ limit: 5 })).length, 0)

  const [after] = await db.listTemplates()
  assert.equal(after.last_posted_on, null, 'a bill that wrote nothing must still be due')
})

await check('a backup fails loudly rather than writing an incomplete file', async () => {
  const backend = await fresh()
  await db.saveTemplate({ label: 'Rent', payee: 'Landlord', amount: 18000 })
  // A dropped connection, not a database without the table — that one already
  // answers [] without throwing.
  db.installBackend(
    { ...backend, listTemplates: async () => { throw new Error('network') } },
    { kind: 'local' },
  )
  await assert.rejects(() => backup(), /network/, 'a half-read backup must not be written')
})

await check('a backup carries repeats, and one written before them still restores', async () => {
  await fresh()
  await db.saveTemplate({
    label: 'Rent',
    payee: 'Landlord',
    amount: 18000,
    rule: { every: 1, unit: 'month', monthDay: 5 },
    starts_on: '2026-03-05',
  })
  const file = await backup()
  assert.equal(file.templates.length, 1)

  await fresh()
  await restore(file)
  const [back] = await db.listTemplates()
  assert.equal(back.label, 'Rent')
  assert.deepEqual(back.rule, { every: 1, unit: 'month', monthDay: 5 })

  // A file written before repeats existed has no such key, and is incomplete
  // rather than unreadable — which is why BACKUP_VERSION was not bumped.
  await fresh()
  const { templates, ...older } = file
  void templates
  const report = await restore(older)
  assert.equal(report.templates.copied, 0)
  assert.equal(report.transactions.copied, older.transactions.length)
})

console.log(`\n${passed} checks passed${failed ? `, ${failed} FAILED` : ''}\n`)
process.exit(failed ? 1 : 0)
