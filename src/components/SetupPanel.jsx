// The four Supabase panels the BYO setup walks through, as real screenshots
// with the arrows drawn on top.
//
// The screenshots in public/setup/ are NOT the originals. scripts/redact-setup-shots.ps1
// destroys the project ID and the anon key in the pixel data — averaged away
// block by block at full resolution, before any downscale — so the files that
// ship carry no trace of them. A drawn-over rectangle or a CSS blur would have
// shipped the original underneath for anyone who opened the file. Re-run that
// script if the screenshots are ever retaken.
//
// The annotations stay as SVG rather than being burnt into the images: they can
// be moved when a panel shifts without retaking anything, they stay sharp at
// any size, and the wording is real text a screen reader can reach.
//
// Every screenshot is of a dark dashboard, whatever theme the app is in. So
// they are framed as pictures — rounded, bordered, on their own dark ground —
// rather than dropped in as though they were part of Hisaab. The arrow colour
// is fixed bright green for the same reason: it sits on the screenshot, not on
// the page, so it does not follow the theme.

const INK = '#9FE870'
const SHADE = 'rgba(9, 12, 8, 0.82)'

/**
 * A screenshot with an annotation layer over it.
 *
 * The SVG viewBox is the image's own pixel size, so every coordinate below is
 * read straight off the file rather than converted into some normalised space.
 */
function Shot({ src, w, h, alt, caption, children }) {
  return (
    <figure style={{ margin: '14px 0 6px' }}>
      <div
        style={{
          position: 'relative',
          borderRadius: 'var(--radius-sm)',
          overflow: 'hidden',
          border: '1px solid var(--rule-strong)',
          background: '#121212',
          lineHeight: 0,
        }}
      >
        <img
          src={src}
          alt={alt}
          width={w}
          height={h}
          // Only ever seen by someone part-way through connecting their own
          // database, which is a minority of a small number of people. No
          // reason for it to cost everyone else a download at install time.
          loading="lazy"
          decoding="async"
          style={{ display: 'block', width: '100%', height: 'auto' }}
        />
        <svg
          viewBox={`0 0 ${w} ${h}`}
          aria-hidden="true"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
        >
          <defs>
            <marker id="shot-tip" viewBox="0 0 10 10" refX="7.5" refY="5" markerWidth="4.5" markerHeight="4.5" orient="auto">
              <path d="M0 0 L10 5 L0 10 z" fill={INK} />
            </marker>
          </defs>
          {children}
        </svg>
      </div>
      {caption && (
        <figcaption className="muted" style={{ fontSize: 11.5, lineHeight: 1.55, marginTop: 8 }}>
          {caption}
        </figcaption>
      )}
    </figure>
  )
}

/** A fat curved arrow. `d` is a path in the image's own coordinates. */
const Arrow = ({ d }) => (
  <path
    d={d}
    fill="none"
    stroke={INK}
    strokeWidth="3"
    strokeLinecap="round"
    markerEnd="url(#shot-tip)"
  />
)

/**
 * A label with its own backing, because these sit on a busy screenshot and
 * plain text on top of a UI is the first thing to become unreadable.
 */
const Tag = ({ x, y, children, anchor = 'end' }) => {
  const width = String(children).length * 7.2 + 16
  const left = anchor === 'end' ? x - width : anchor === 'middle' ? x - width / 2 : x
  return (
    <>
      <rect x={left} y={y - 13} width={width} height="20" rx="10" fill={SHADE} />
      <text
        x={left + width / 2}
        y={y + 1.5}
        fontSize="12.5"
        fontWeight="700"
        textAnchor="middle"
        fill={INK}
        fontFamily="var(--sans)"
      >
        {children}
      </text>
    </>
  )
}

/** Step 1 — the new-project form. The region is the only choice that matters
 *  and the only one that cannot be changed later. */
export const NewProject = () => (
  <Shot
    src="/setup/1.png"
    w={840}
    h={334}
    alt="Supabase's new project form: project name, database password, and a region dropdown."
    caption="Region is the one thing here you cannot change later — it is where your money data physically sits."
  >
    <Arrow d="M150 318 q70 26 138 -38" />
    <Tag x={146} y={318}>pick your region</Tag>
  </Shot>
)

/** Step 2a — the project ID. */
export const ProjectId = () => (
  <Shot
    src="/setup/3.png"
    w={900}
    h={359}
    alt="Supabase project settings, General. The Project ID row is blanked out in this picture."
    caption="Blanked out here on purpose — that row is the one thing on the page that identifies your database."
  >
    <Arrow d="M470 310 q100 20 168 -72" />
    <Tag x={466} y={310}>copy this</Tag>
  </Shot>
)

/** Step 2b — the API keys page. Two things to say: the right tab, and the row
 *  never to touch. */
export const ApiKeys = () => (
  <Shot
    src="/setup/4.png"
    w={900}
    h={327}
    alt="Supabase API keys, on the legacy tab. The anon public key is blanked out; the service_role key is hidden behind a Reveal button."
    caption="The page opens on the other tab. The anon key is blanked out here for the same reason as the project ID."
  >
    <Arrow d="M300 40 q42 12 78 26" />
    <Tag x={296} y={38}>this tab first</Tag>

    <Arrow d="M700 60 q110 30 146 58" />
    <Tag x={696} y={58}>copy this one</Tag>

    <Arrow d="M120 250 q60 -30 92 -48" />
    <Tag x={116} y={252} anchor="start">never this one</Tag>
  </Shot>
)

/** Step 4 — the sign-up toggles, and the Save button people forget. */
export const ConfirmEmail = () => (
  <Shot
    src="/setup/2.png"
    w={900}
    h={378}
    alt="Supabase authentication providers, User Signups: toggles for allowing sign-ups and for confirming email, with a Save changes button."
    caption="Leave manual linking and anonymous sign-ins alone. Both switches shown are wrong in this picture — that is how they start."
  >
    <Arrow d="M700 150 q100 20 148 26" />
    <Tag x={696} y={148}>turn on</Tag>

    <Arrow d="M700 282 q100 18 148 24" />
    <Tag x={696} y={280}>turn off</Tag>

    <Arrow d="M600 356 q120 6 216 -6" />
    <Tag x={596} y={356}>then save</Tag>
  </Shot>
)
