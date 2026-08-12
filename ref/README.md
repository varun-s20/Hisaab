# ref/

Sample exports from other apps, kept to test the importer against the shape of
a real file rather than an imagined one.

**Everything in here except this README is gitignored.** These are real ledgers
— every amount, every note, every account name. The same rule as `screenshots/`:
the shape is worth keeping, the money is not worth committing.

`scripts/test-parse.mjs` carries an invented copy of each shape instead, so
`npm test` passes on a fresh clone with this folder empty.

## What the importer reads

`src/lib/statement.js` finds columns by name, so most exports work without
being touched. It looks for, in this order:

| Field | Header names it knows |
|---|---|
| Date | date, txn date, value date, **time**, datetime, timestamp, … |
| Reference | ref, utr, transaction id, cheque no, … |
| Type | type, transaction type, dr cr, **income expense**, … |
| Category | **category**, category name, main category, parent category |
| Account | **account**, account name, **wallet**, from account, paid from |
| Debit / Credit | debit, withdrawal, credit, deposit, paid in, paid out, … |
| Amount | amount, amt, **inr**, **cost**, **price**, **spent** |
| Description | description, narration, particulars, payee, **note**, **notes**, **memo**, **item**, **title**, … |

Two rules that matter more than the names:

- **A type column stating `Income` or `Transfer` wins.** Income becomes money
  in; a transfer becomes type `transfer`, which counts in no total — otherwise
  moving your own money between envelopes reads as spending.
- **`Dr` / `Cr` deliberately do not.** That is what a bank writes, and an
  unrecognised bank credit is usually a friend paying you back, not income.
  `typeFor()` in `src/lib/categorise.js` makes that call and this must not
  overrule it.

Categories in the file are kept. Obvious synonyms are mapped onto the app's
fourteen (`Food` → `Food & Dining`, `Transportation` → `Transport`); anything
else passes through as its own word.

## Adding a new app

Drop the export here, run it through the parser, and read the output:

```bash
node -e "import('./src/lib/statement.js').then(async ({parseStatement}) => {
  const t = (await import('node:fs')).readFileSync('ref/YOUR_FILE.csv','utf8')
  const { rows, skipped, columns } = parseStatement(t)
  console.log(columns); console.log(rows.length, 'rows,', skipped.length, 'skipped')
  console.log(rows.slice(0, 3))
})"
```

`columns` with a `-1` in it is a header name `NAMES` has not been taught yet.
Add the alias, then add a fixture to `scripts/test-parse.mjs` — invented
numbers, real shape.
