// Sub-screens reached from More are dead ends without this. The hardware/browser
// back button works too — App puts every tab in history — but a thumb at the top
// of a 6" phone needs something to press.

export default function ScreenHeader({ title, onBack, action }) {
  return (
    <div className="screenhead">
      {onBack && (
        <button className="iconbtn" onClick={onBack} aria-label="Back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m15 18-6-6 6-6" />
          </svg>
        </button>
      )}
      <h1 className="title">{title}</h1>
      {action}
    </div>
  )
}
