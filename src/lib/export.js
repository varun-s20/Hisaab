import {
  activeAdapter, listBudgets, listCategories, listMerchantMap, listTemplates, listTransactions,
  snapshotTransactions,
} from './db.js'
import { copyLedger } from './migrate.js'
import { toCSV } from './csv.js'
import { today } from './format.js'

// The exit door. The file format is in lib/csv.js; this is the part that has to
// talk to the database and the browser.

/**
 * Every row, oldest first. `listTransactions` pages past PostgREST's 1000-row
 * cap, so the only ceiling is the one asked for here.
 *
 * ponytail: 20000 rows is roughly twenty years of heavy use and about 2MB of
 * text, which is fine to build in memory on a phone. A ledger past that wants
 * streaming, and will say so by being slow.
 */
export async function exportAll() {
  const rows = await listTransactions({ limit: 20000 })
  return toCSV([...rows].reverse())
}

// ── The backup file ────────────────────────────────────────────────────────
//
// A CSV is the exit door to another app. This is the different thing: the file
// that can rebuild Hisaab exactly as it was.
//
// It exists because "This device" is the one backend with nobody else holding a
// copy. Browser storage is evictable, and clearing site data takes a ledger
// with it — so that mode cannot be switched on until one of these has been
// saved, and the screen keeps asking afterwards.
//
// The merchant map is the reason this is JSON and not a spreadsheet. It is the
// only thing here a person cannot reconstruct by re-importing statements, and
// a CSV of transactions does not carry it.

// Deliberately not bumped when `templates` was added.
//
// The version gate refuses a file outright, so raising it would have made every
// backup written before repeats existed unrestorable — for a field those files
// simply do not have. Adding an optional key is compatible in both directions:
// an older build ignores one it does not know about, and this one reads its
// absence as "none". A bump is for a change that makes an old file WRONG rather
// than incomplete.
export const BACKUP_VERSION = 1

export async function backup() {
  const [transactions, merchants, budgets, categories, templates] = await Promise.all([
    snapshotTransactions(),
    listMerchantMap(),
    listBudgets(),
    // Read from the backend, not from the localStorage mirror. The mirror is a
    // cache and can be a launch behind; a backup written from a cache is the
    // sort of thing you only find out about on the day you need it.
    listCategories(),
    // A repeat cannot be rebuilt from the transactions it wrote — twelve rents
    // in the ledger say nothing about the rule that put them there.
    //
    // Uncaught, like the four above it. A database with no templates table
    // already answers [] without throwing (lib/backends/supabase.js), so the
    // only errors a catch here could swallow are the real ones — a dropped
    // connection, a permission failure — and a backup that quietly writes
    // `templates: []` because the network hiccuped is discovered on the day it
    // is restored. Failing the backup is the honest outcome.
    listTemplates(),
  ])
  return {
    hisaab: BACKUP_VERSION,
    saved_at: new Date().toISOString(),
    transactions,
    merchants,
    budgets,
    categories,
    templates,
  }
}

/** Reject a file that is not one of ours before it touches anything. */
export function backupProblem(data) {
  if (!data || typeof data !== 'object') return 'That file is not a Hisaab backup.'
  // Absent and wrong are different failures and deserve different sentences.
  // Both used to come out as "written by a different version (unknown)", which
  // sends somebody hunting for an older Hisaab to open a file that was never
  // ours in the first place.
  if (data.hisaab === undefined) return 'That file is not a Hisaab backup.'
  if (data.hisaab !== BACKUP_VERSION) {
    return `That backup was written by a different version of Hisaab (${data.hisaab}).`
  }
  if (!Array.isArray(data.transactions)) return 'That backup has no transactions in it.'
  return null
}

/**
 * A backup file, wearing enough of the backend interface to be copied out of.
 *
 * Only the read half, because lib/migrate.js never writes to a source. That is
 * the whole trick here: restoring is not a second import path with its own
 * dedup and its own bugs, it is the switch machinery pointed at a file. Merging
 * by id and txn_ref, skipping what is already there, carrying every table —
 * all of it already exists and is already tested.
 */
function fileBackend(data) {
  const rows = data.transactions ?? []
  return {
    kind: 'file',
    capabilities: () => ({ toAccount: true, budgetScope: true, templates: true }),
    ready: async () => ({ ok: true, missing: [] }),
    listAllTransactions: async ({ limit = rows.length } = {}) => rows.slice(0, limit),
    listMerchantMap: async () => data.merchants ?? [],
    listBudgets: async () => data.budgets ?? [],
    listCategories: async () => data.categories ?? [],
    // Absent in any backup written before repeats existed, which is a file with
    // no repeats in it rather than a file that cannot be read.
    listTemplates: async () => data.templates ?? [],
  }
}

/**
 * Put a backup file back, into whichever backend is live.
 *
 * Adds; never removes. A restore into a ledger that already has rows fills in
 * what is missing and leaves everything else alone, which is the only safe
 * reading of the request — somebody restoring a three-month-old file onto a
 * working phone means "get my old data back", not "throw away this quarter".
 * Running it twice changes nothing the second time.
 *
 * Returns the same report a backend switch does, so the screen can say what
 * actually happened rather than "done".
 */
export async function restore(data) {
  const problem = backupProblem(data)
  if (problem) throw new Error(problem)
  return copyLedger(fileBackend(data), await activeAdapter())
}

/** Read a file the user picked, and fail with something readable if it is not
 *  JSON at all — dropping in a CSV is the obvious mistake to make here. */
export async function readBackupFile(file) {
  let text
  try {
    text = await file.text()
  } catch {
    throw new Error('That file could not be read.')
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('That file is not a Hisaab backup — it is not even JSON. Look for hisaab-backup-….json')
  }
}

/** Hand the file to the browser. Revoked on the next tick, not left to leak. */
export function download(csv, name = `hisaab-${today()}.csv`) {
  // ﻿: without the BOM, Excel on Windows reads the file as the system
  // codepage and a merchant name in Devanagari — or a plain ₹ — comes out as
  // mojibake. Every other reader ignores it.
  const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  // In the document, not detached: Safari ignores a click on an anchor that
  // was never in the tree, and this app is mostly opened on a phone.
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}

/**
 * Save a backup file.
 *
 * Same mechanics as the CSV above minus the BOM — nothing reads this but
 * Hisaab, and a BOM in front of a JSON document breaks JSON.parse in most
 * runtimes.
 *
 * Where it lands is the browser's business: Downloads on Android, Files on
 * iOS, wherever the user points it on a desktop. A page cannot write to a
 * chosen folder on a phone and cannot start a download without a tap, which is
 * why nothing here is automatic and the screen has to ask.
 */
export function downloadBackup(data, name = `hisaab-backup-${today()}.json`) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  )
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 0)
}
