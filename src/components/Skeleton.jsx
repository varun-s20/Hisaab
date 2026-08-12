// Loading shapes. One set for the whole app, because six screens inventing
// their own placeholder is six different answers to "is this broken or is it
// slow" — which is the only question a loading state has to answer.
//
// The shapes trace the layout that is coming, never a generic spinner: the
// point is that nothing jumps when the data lands.

/** A single bar. Everything else here is made of these. */
export function Bar({ w = '100%', h = 14, r = 8, style }) {
  return <span className="skel" aria-hidden="true" style={{ width: w, height: h, borderRadius: r, ...style }} />
}

/** The big green hero panel — Today, Insights, Budgets all open with one. */
export function HeroSkeleton() {
  return (
    <div className="skel-hero">
      <Bar w="38%" h={12} />
      <Bar w="62%" h={38} style={{ marginTop: 14 }} />
      <div className="skel-hero-foot">
        <Bar w="45%" h={12} />
        <Bar w="45%" h={12} />
      </div>
    </div>
  )
}

/** A card of ledger rows: tile, two lines of text, an amount. */
export function RowsSkeleton({ rows = 3, head = false }) {
  return (
    <div className="card">
      {head && (
        <div className="card-head">
          <Bar w={90} h={12} />
          <Bar w={54} h={12} />
        </div>
      )}
      <ul className="ledger">
        {Array.from({ length: rows }, (_, i) => (
          <li key={i}>
            <div className="row">
              <Bar w={38} h={38} r={12} />
              <span className="who">
                {/* Widths walk down the list so it reads as real names rather
                    than a stack of identical grey bricks. */}
                <Bar w={`${72 - i * 9}%`} h={13} />
                <Bar w={`${48 - i * 6}%`} h={11} style={{ marginTop: 7 }} />
              </span>
              <Bar w={58} h={14} />
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** A form-ish panel: label, field, label, field. */
export function PanelSkeleton({ fields = 3 }) {
  return (
    <div className="panel">
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} style={{ marginBottom: i === fields - 1 ? 0 : 16 }}>
          <Bar w={78} h={11} />
          <Bar h={46} r={12} style={{ marginTop: 7 }} />
        </div>
      ))}
    </div>
  )
}

/** A plain block, for a chart or a bar that has no inner structure worth tracing. */
export default function Skeleton({ h = 120, style }) {
  return <Bar h={h} r="var(--radius)" style={{ display: 'block', ...style }} />
}
