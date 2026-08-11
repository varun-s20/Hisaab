import { MODES, step, atLatest } from '../lib/range'

// Day / Week / Month / Custom, with arrows to walk backwards through periods.
// The label between the arrows is the whole point — "This week" and "Jul" tell
// you where you are without reading two dates.

export default function RangePicker({ mode, setMode, anchor, setAnchor, custom, setCustom, range }) {
  const latest = atLatest(mode, anchor)

  return (
    <div className="rangebar">
      <div className="segmented" role="tablist" aria-label="Period">
        {MODES.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={mode === id}
            onClick={() => setMode(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {mode === 'custom' ? (
        <div className="customrange">
          <label className="field">
            <span>From</span>
            <input
              type="date"
              value={custom.from}
              max={custom.to}
              onChange={(e) => setCustom({ ...custom, from: e.target.value })}
            />
          </label>
          <label className="field">
            <span>To</span>
            <input
              type="date"
              value={custom.to}
              min={custom.from}
              onChange={(e) => setCustom({ ...custom, to: e.target.value })}
            />
          </label>
        </div>
      ) : (
        <div className="stepper">
          <button aria-label="Previous period" onClick={() => setAnchor(step(mode, anchor, -1))}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m15 18-6-6 6-6" />
            </svg>
          </button>
          <span className="stepper-label">{range.label}</span>
          <button
            aria-label="Next period"
            disabled={latest}
            onClick={() => setAnchor(step(mode, anchor, 1))}
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        </div>
      )}
    </div>
  )
}
