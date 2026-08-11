import { useState } from 'react'
import { parseStatement } from '../lib/statement'
import { categoriseBatch, persistAILearnings } from '../lib/categorise'
import { saveTransactions, deleteTransactions } from '../lib/db'
import { money } from '../lib/format'
import CategoryIcon from '../components/CategoryIcon.jsx'
import ScreenHeader from '../components/ScreenHeader.jsx'

// BUILD_GUIDE.md §8.2. Screenshots catch ~70%. This is what makes the ledger
// true rather than indicative.

const FIELDS = [
  ['date', 'Date'],
  ['description', 'Description'],
  ['amount', 'Amount'],
  ['debit', 'Debit'],
  ['credit', 'Credit'],
  ['ref', 'Reference'],
  ['type', 'Type'],
]

const rupees = (n) => (
  <span className="num">
    <span className="rupee">₹</span>
    {money(n)}
  </span>
)

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

function Skipped({ rows }) {
  if (!rows.length) return null
  return (
    <details>
      <summary className="muted">{plural(rows.length, 'row', 'rows')} skipped</summary>
      <ul className="ledger">
        {rows.slice(0, 50).map((s) => (
          <li key={s.line} className="muted">
            Line {s.line}. {s.reason}. {s.text}
          </li>
        ))}
      </ul>
    </details>
  )
}

export default function Import({ onChange, onBack }) {
  const [file, setFile] = useState(null) // { name, rows, skipped, columns, header }
  const [busy, setBusy] = useState(false)
  const [parsing, setParsing] = useState(false)
  const [result, setResult] = useState(null)
  const [undone, setUndone] = useState(0)
  const [error, setError] = useState(null) // a whole sentence — each path says its own thing

  async function pick(e) {
    const f = e.target.files?.[0]
    e.target.value = '' // re-picking the same file must still fire onChange
    if (!f) return
    setError(null)
    setResult(null)
    setFile(null)
    // parseStatement walks the whole file on this thread, and a year of exported
    // rows is a visible freeze. The read is awaited first so this paints before it.
    setParsing(true)
    try {
      const text = await f.text()
      setFile({ name: f.name, ...parseStatement(text) })
    } catch (err) {
      setError(`Couldn’t read this file. ${err.message}`)
    } finally {
      setParsing(false)
    }
  }

  async function commit() {
    setBusy(true)
    setError(null)
    try {
      const categorised = await categoriseBatch(file.rows)
      const saved = await saveTransactions(categorised)
      // The rows are in the ledger from here on, so the result — and with it the
      // only Undo there is — goes up before anything else gets to throw. The
      // learning write is not allowed to report a 400-row import as "nothing
      // was written"; Today.jsx fires it the same way.
      setResult({ ...saved, skipped: file.skipped })
      setUndone(0)
      setFile(null)
      onChange?.()
      persistAILearnings(categorised).catch(() => {}) // never block on this
    } catch (err) {
      setError(`Import stopped. ${err.message} Nothing was written.`)
    } finally {
      setBusy(false)
    }
  }

  /**
   * Undo by the ids the insert handed back, not by date range — a range would
   * also take rows that were already there. Offered only while the result is on
   * screen: a wrong CSV is discovered immediately or not at all, and persisting
   * a batch id for a regret you can also fix row by row is not worth a column.
   */
  async function undo() {
    const ids = (result?.rows ?? []).map((r) => r.id)
    if (ids.length === 0) return
    setBusy(true)
    try {
      await deleteTransactions(ids)
      setResult(null)
      setUndone(ids.length)
      onChange?.()
    } catch (err) {
      setError(`Couldn’t undo. ${err.message} The rows are still in the ledger.`)
    } finally {
      setBusy(false)
    }
  }

  const worth = (result?.rows ?? []).reduce((s, r) => s + Number(r.amount), 0)
  const needCats = (result?.rows ?? []).filter((r) => r.needs_review).length

  return (
    <div className="screen">
      <ScreenHeader title="Import a statement" onBack={onBack} />
      <p className="muted">
        Screenshots catch most days. A monthly export from GPay, PhonePe, Paytm or your bank
        catches the rest. Anything already logged is skipped.
      </p>

      <input
        id="statement-file"
        type="file"
        accept=".csv,.txt"
        className="hidden-file"
        disabled={parsing}
        onChange={pick}
      />
      <label className="btn ghost" htmlFor="statement-file">
        {parsing ? 'Reading the file…' : file ? 'Choose a different file' : 'Choose a file'}
      </label>
      <p className="muted">CSV or text export only.</p>

      {file && (
        <>
          <h2 className="section">{file.name}</h2>

          {file.columns.date < 0 ? (
            <p className="alert">
              No date and amount columns found. This does not look like a statement export.
            </p>
          ) : (
            <div className="panel">
              {FIELDS.filter(([k]) => file.columns[k] >= 0).map(([k, label]) => (
                <div className="stat" key={k}>
                  <span className="k">{label}</span>
                  <span className="v">{file.header[file.columns[k]]}</span>
                </div>
              ))}
            </div>
          )}

          {file.rows.length === 0 ? (
            <p className="empty">Nothing readable in this file.</p>
          ) : (
            <>
              <div className="card">
                <ul className="ledger">
                  {file.rows.slice(0, 3).map((r, i) => (
                    <li key={i}>
                      <div className="row">
                        <CategoryIcon category="Other" />
                        <div className="who">
                          <div className="name">{r.payee_raw ?? 'No description'}</div>
                          <div className="meta">
                            {r.txn_date}
                            {r.method ? ` · ${r.method}` : ''}
                            {r.txn_ref ? ` · ${r.txn_ref}` : ''}
                          </div>
                        </div>
                        <div className={`amt ${r.direction === 'credit' ? 'in' : 'out'}`}>
                          {rupees(r.amount)}
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
              <p className="muted">
                {plural(file.rows.length, 'row', 'rows')} ready
                {file.rows.length > 3 ? ', first three shown' : ''}.
              </p>
            </>
          )}

          <Skipped rows={file.skipped} />

          {/* The one place in the app where a confirmation step is correct.
              Everywhere else an action writes a single row and can just happen;
              a statement writes hundreds, so a wrong-format CSV committed on
              file-pick would bury the ledger. Read the columns above, then commit. */}
          <button className="btn" onClick={commit} disabled={busy || file.rows.length === 0}>
            {busy ? 'Importing' : `Import ${plural(file.rows.length, 'row', 'rows')}`}
          </button>
        </>
      )}

      {result && (
        <>
          <h2 className="section">Result</h2>
          <p>
            {result.saved > 0 ? (
              <>
                Added {plural(result.saved, 'missed transaction', 'missed transactions')} worth{' '}
                {rupees(worth)}.
              </>
            ) : (
              'Nothing new in this file.'
            )}
            {needCats > 0 && ` ${needCats === 1 ? '1 needs a category' : `${needCats} need categories`}.`}
            {result.duplicates > 0 && ` ${result.duplicates} already logged.`}
            {result.unusable > 0 && ` ${plural(result.unusable, 'row', 'rows')} had no description.`}
          </p>
          {result.saved > 0 && (
            <p>
              <button className="linkish danger-link" disabled={busy} onClick={undo}>
                Undo this import
              </button>
            </p>
          )}
          <Skipped rows={result.skipped} />
        </>
      )}

      {undone > 0 && (
        <p className="muted">Removed {plural(undone, 'row', 'rows')}. The ledger is back as it was.</p>
      )}

      {error && <p className="alert">{error}</p>}
    </div>
  )
}
