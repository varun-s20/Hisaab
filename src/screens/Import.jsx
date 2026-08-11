import { useState } from 'react'
import { parseStatement } from '../lib/statement'
import { categoriseBatch, persistAILearnings } from '../lib/categorise'
import { saveTransactions } from '../lib/db'
import { money } from '../lib/format'

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

export default function Import({ onChange }) {
  const [file, setFile] = useState(null) // { name, rows, skipped, columns, header }
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  async function pick(e) {
    const f = e.target.files?.[0]
    e.target.value = '' // re-picking the same file must still fire onChange
    if (!f) return
    setError(null)
    setResult(null)
    try {
      setFile({ name: f.name, ...parseStatement(await f.text()) })
    } catch (err) {
      setFile(null)
      setError(err.message)
    }
  }

  async function commit() {
    setBusy(true)
    setError(null)
    try {
      const categorised = await categoriseBatch(file.rows)
      const saved = await saveTransactions(categorised)
      await persistAILearnings(categorised)
      setResult({ ...saved, skipped: file.skipped })
      setFile(null)
      onChange?.()
    } catch (err) {
      setError(err.message)
    } finally {
      setBusy(false)
    }
  }

  const worth = (result?.rows ?? []).reduce((s, r) => s + Number(r.amount), 0)
  const needCats = (result?.rows ?? []).filter((r) => r.needs_review).length

  return (
    <div className="screen">
      <p className="eyebrow">Reconcile</p>
      <h1 className="title">Import a statement</h1>
      <p className="muted">
        Screenshots catch most days. A monthly export from GPay, PhonePe, Paytm or your bank
        catches the rest. Anything already logged is skipped.
      </p>

      <input id="statement-file" type="file" accept=".csv,.txt" className="hidden-file" onChange={pick} />
      <label className="btn ghost" htmlFor="statement-file">
        {file ? 'Choose a different file' : 'Choose a file'}
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
              <ul className="ledger">
                {file.rows.slice(0, 3).map((r, i) => (
                  <li className="row" key={i}>
                    <span className="dot" />
                    <div className="who">
                      <div className="name">{r.payee_raw ?? 'No description'}</div>
                      <div className="meta">
                        {r.txn_date}
                        {r.method ? ` · ${r.method}` : ''}
                        {r.txn_ref ? ` · ${r.txn_ref}` : ''}
                      </div>
                    </div>
                    <div className={`amt ${r.direction === 'credit' ? 'in' : 'out'}`}>{rupees(r.amount)}</div>
                  </li>
                ))}
              </ul>
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
          <Skipped rows={result.skipped} />
        </>
      )}

      {error && <p className="alert">Import stopped. {error} Nothing was written.</p>}
    </div>
  )
}
