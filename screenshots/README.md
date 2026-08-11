# Drop your screenshots here

Put 5–10 real payment screenshots in this folder. Ideally a mix:

- 2–3 GPay
- 2–3 PhonePe
- 2–3 Paytm
- at least one **received money** screenshot (credit, not debit)
- at least one paid to a **person** (not a shop)

Then run:

```
npm run ocr
```

It writes `ocr-output.txt` next to them. That raw text is what the parsers get
written against — see `BUILD_GUIDE.md` §6.1.

**These images stay on your machine.** They are gitignored, never uploaded, and
never stored by the app. Delete them once the parsers work.
