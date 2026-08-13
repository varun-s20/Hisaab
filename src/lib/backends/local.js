// The on-device backend. IndexedDB for durability, a plain array for querying.
//
// There is no query engine here and there should not be one. A ledger this app
// can hold is a few thousand rows — `listAllTransactions` already caps at 5000
// and an export at 20000 — which is nothing to filter and sort in JavaScript.
// Reimplementing PostgREST's filter syntax to save that would buy a parser that
// is subtly wrong about somebody's money.
//
// So: read every row into memory once, answer from there, write through to
// IndexedDB on every mutation. Same row shape as Postgres, so lib/db.js runs
// the same computation over both backends and a migration is a straight copy.
//
// What this is NOT: durable the way a server is. Browser storage is evictable,
// and clearing site data takes it with everything else. The settings screen
// says so before this mode can be turned on, and the app asks for a backup.

const DB_NAME = 'hisaab'
// Bumped when a store is added. `onupgradeneeded` only fires on a version
// change, so a device that already opened v1 would never get the categories
// store without this and every read of it would throw NotFoundError.
const DB_VERSION = 3
const STORES = ['transactions', 'merchant_map', 'budgets', 'categories', 'templates']

/** Promisify one IDB request. */
const request = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })

function openDatabase() {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(DB_NAME, DB_VERSION)
    open.onupgradeneeded = () => {
      const db = open.result
      // keyPath 'id' across all three, matching the uuid primary key in
      // db/schema.sql so a row is the same object on either backend.
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' })
      }
    }
    open.onsuccess = () => resolve(open.result)
    open.onerror = () => reject(open.error ?? new Error('IndexedDB could not be opened'))
    // Fires when another tab holds an older version open. Nothing to do but
    // say so — the caller surfaces it rather than hanging forever.
    open.onblocked = () => reject(new Error('Close Hisaab in your other tabs and try again.'))
  })
}

/**
 * Ask the browser not to evict us.
 *
 * Without this, browser storage is "best effort" and the OS may clear it under
 * storage pressure — for a money ledger that is data loss with no warning. An
 * installed PWA is usually granted this without a prompt. It can be refused,
 * and a refusal is not fatal, so it never blocks startup: the backup file is
 * what actually protects the user, and the settings screen says as much.
 */
async function requestPersistence() {
  try {
    if (await navigator.storage?.persisted?.()) return true
    return Boolean(await navigator.storage?.persist?.())
  } catch {
    return false
  }
}

/**
 * Newest first, exactly as PostgREST is asked to order in the Supabase backend:
 * txn_date desc, created_at desc, id desc. The third key is what stops a page
 * boundary landing inside a tie there; here it is what keeps the two backends
 * returning the same sequence for the same rows, which is the only way the
 * shared computation above can be trusted.
 */
const byNewest = (a, b) =>
  String(b.txn_date ?? '').localeCompare(String(a.txn_date ?? '')) ||
  String(b.created_at ?? '').localeCompare(String(a.created_at ?? '')) ||
  String(b.id ?? '').localeCompare(String(a.id ?? ''))

export function localBackend() {
  let db = null
  /** @type {Map<string, Map<string, object>>} table -> id -> row */
  const cache = new Map()
  let loaded = null

  async function load() {
    if (loaded) return loaded
    loaded = (async () => {
      db = await openDatabase()
      await requestPersistence()
      const tx = db.transaction(STORES, 'readonly')
      const rows = await Promise.all(STORES.map((s) => request(tx.objectStore(s).getAll())))
      STORES.forEach((name, i) => {
        cache.set(name, new Map((rows[i] ?? []).map((r) => [r.id, r])))
      })
    })()
    return loaded
  }

  const table = (name) => cache.get(name)
  const rowsIn = (name) => [...table(name).values()]

  /** Write through. The in-memory copy is only ever updated once the durable
   *  one has accepted the change, so a failed write cannot leave the screen
   *  showing a row that was never stored. */
  async function put(name, rows) {
    if (!rows.length) return
    const tx = db.transaction(name, 'readwrite')
    const store = tx.objectStore(name)
    await Promise.all(rows.map((r) => request(store.put(r))))
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'))
    })
    for (const r of rows) table(name).set(r.id, r)
  }

  async function drop(name, ids) {
    if (!ids.length) return
    const tx = db.transaction(name, 'readwrite')
    const store = tx.objectStore(name)
    await Promise.all(ids.map((id) => request(store.delete(id))))
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB delete failed'))
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB delete aborted'))
    })
    for (const id of ids) table(name).delete(id)
  }

  const nowStamp = () => new Date().toISOString()

  return {
    kind: 'local',

    // Nothing is behind a migration here — the store is created with every
    // column the app knows about, so every feature is always present. The
    // version bump above is what guarantees it on a device that opened an
    // older build.
    capabilities: () => ({ toAccount: true, budgetScope: true, templates: true }),

    async ready() {
      if (typeof indexedDB === 'undefined') {
        return { ok: false, missing: STORES, message: 'This browser has no storage Hisaab can use.' }
      }
      try {
        await load()
        return { ok: true, missing: [], persisted: await requestPersistence() }
      } catch (e) {
        return { ok: false, missing: STORES, message: e?.message ?? 'Storage could not be opened.' }
      }
    },

    // ── Transactions ───────────────────────────────────────────────────────

    /**
     * The unique index on (user_id, txn_ref) is what stops the same UPI
     * reference being stored twice on Postgres. There is no index to lean on
     * here, so the same rule is applied in code — and it has to be, because
     * db.js reports a duplicate count it would otherwise get wrong, and because
     * re-importing last week's screenshots is a thing people do by accident.
     */
    async insertTransactions(rows) {
      await load()
      const existing = new Set(rowsIn('transactions').map((r) => r.txn_ref).filter(Boolean))
      const saved = []
      let rejected = 0
      for (const row of rows) {
        if (row.txn_ref && existing.has(row.txn_ref)) {
          rejected += 1
          continue
        }
        if (row.txn_ref) existing.add(row.txn_ref)
        saved.push({
          ...row,
          // Postgres fills both of these by default. Nothing else does, and a
          // row without them sorts wrong and cannot be updated by id.
          id: row.id ?? crypto.randomUUID(),
          created_at: row.created_at ?? nowStamp(),
        })
      }
      await put('transactions', saved)
      return { saved, rejected }
    },

    async listTransactions({ from, to, limit = 500 } = {}) {
      await load()
      return rowsIn('transactions')
        .filter((r) => (!from || r.txn_date >= from) && (!to || r.txn_date <= to))
        .sort(byNewest)
        .slice(0, limit)
    },

    /** `columns` is honoured on Supabase to save bandwidth and ignored here —
     *  the rows are already in memory, and handing back whole ones costs
     *  nothing. Callers read only the fields they asked for either way. */
    async listAllTransactions({ limit = 5000 } = {}) {
      await load()
      return rowsIn('transactions').sort(byNewest).slice(0, limit)
    },

    async findExistingRefs(refs) {
      await load()
      const want = new Set(refs)
      const seen = new Set()
      for (const r of rowsIn('transactions')) {
        if (r.txn_ref && want.has(r.txn_ref)) seen.add(r.txn_ref)
      }
      return seen
    },

    async updateTransactions(ids, patch) {
      await load()
      const next = []
      for (const id of ids) {
        const row = table('transactions').get(id)
        if (row) next.push({ ...row, ...patch, id })
      }
      await put('transactions', next)
      return next
    },

    async deleteTransactions(ids) {
      await load()
      const present = ids.filter((id) => table('transactions').has(id))
      await drop('transactions', present)
      return present.length
    },

    async listNeedsReview() {
      await load()
      return rowsIn('transactions').filter((r) => r.needs_review === true).sort(byNewest)
    },

    async countNeedsReview() {
      await load()
      return rowsIn('transactions').filter((r) => r.needs_review === true).length
    },

    // ── Merchant map ───────────────────────────────────────────────────────

    async listMerchantMap() {
      await load()
      return rowsIn('merchant_map').sort((a, b) => (b.hit_count ?? 0) - (a.hit_count ?? 0))
    },

    /**
     * `unique (user_id, payee_pattern)` in the schema, so the pattern is the
     * real key and the uuid is incidental. `ignoreDuplicates` is how an AI
     * guess is stopped from overwriting a correction the user made by hand —
     * on Postgres the database refuses it, and it has to refuse it here too.
     */
    async upsertMerchantMapping(row, { ignoreDuplicates = false } = {}) {
      await load()
      const existing = rowsIn('merchant_map').find((r) => r.payee_pattern === row.payee_pattern)
      if (existing && ignoreDuplicates) return existing
      const next = {
        ...existing,
        ...row,
        id: existing?.id ?? crypto.randomUUID(),
        created_at: existing?.created_at ?? nowStamp(),
      }
      await put('merchant_map', [next])
      return next
    },

    async deleteMerchantMapping(payee_pattern) {
      await load()
      const ids = rowsIn('merchant_map')
        .filter((r) => r.payee_pattern === payee_pattern)
        .map((r) => r.id)
      await drop('merchant_map', ids)
    },

    // ── Budgets ────────────────────────────────────────────────────────────

    async listBudgets() {
      await load()
      return rowsIn('budgets').map((b) => ({ ...b, scope: b.scope ?? 'category' }))
    },

    /** `unique (user_id, scope, category)`. Both halves of the key matter: an
     *  account named "Rent" and a category named "Rent" are two different caps
     *  and must not collide. */
    async upsertBudget({ scope = 'category', category, amount }) {
      await load()
      const existing = rowsIn('budgets').find(
        (b) => (b.scope ?? 'category') === scope && b.category === category,
      )
      await put('budgets', [
        {
          id: existing?.id ?? crypto.randomUUID(),
          created_at: existing?.created_at ?? nowStamp(),
          scope,
          category,
          amount,
        },
      ])
    },

    async deleteBudget({ scope = 'category', category }) {
      await load()
      const ids = rowsIn('budgets')
        .filter((b) => (b.scope ?? 'category') === scope && b.category === category)
        .map((b) => b.id)
      await drop('budgets', ids)
    },

    // ── Categories the user made ───────────────────────────────────────────

    async listCategories() {
      await load()
      return rowsIn('categories').sort((a, b) => String(a.name).localeCompare(String(b.name)))
    },

    /** `unique (user_id, name)` in the schema, so the name is the real key and
     *  the uuid is incidental — same shape as the merchant map. */
    async upsertCategory(row) {
      await load()
      const existing = rowsIn('categories').find((c) => c.name === row.name)
      await put('categories', [
        {
          ...existing,
          ...row,
          id: existing?.id ?? crypto.randomUUID(),
          created_at: existing?.created_at ?? nowStamp(),
        },
      ])
    },

    async deleteCategory(name) {
      await load()
      await drop('categories', rowsIn('categories').filter((c) => c.name === name).map((c) => c.id))
    },

    // ── Repeats: tiles and bills ───────────────────────────────────────────

    async listTemplates() {
      await load()
      return rowsIn('templates').sort(
        (a, b) => String(a.label ?? '').localeCompare(String(b.label ?? '')),
      )
    },

    /** Keyed on the uuid, unlike the merchant map and categories — two bills to
     *  the same payee for different amounts are two bills, and nothing about a
     *  template is naturally unique. The caller decides what is a duplicate. */
    async upsertTemplate(row) {
      await load()
      const existing = row.id ? table('templates').get(row.id) : null
      const next = {
        ...existing,
        ...row,
        id: existing?.id ?? row.id ?? crypto.randomUUID(),
        created_at: existing?.created_at ?? row.created_at ?? nowStamp(),
      }
      await put('templates', [next])
      return next
    },

    async deleteTemplate(id) {
      await load()
      await drop('templates', table('templates').has(id) ? [id] : [])
    },

    async clear() {
      await load()
      for (const name of STORES) {
        await drop(name, rowsIn(name).map((r) => r.id))
      }
    },
  }
}
