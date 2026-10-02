import type { TeamShape, TradeFit } from '@/lib/room'

/**
 * The room, sorted by who you should be talking to.
 *
 * The ordering IS the feature. Eighteen rosters listed 1..18 is a record you
 * scan once; the same eighteen ranked by how well they complement your roster
 * puts the answer in the first row. That is the difference between a draft
 * grid — which every fantasy site already has — and the thing the guide
 * actually tells people to do.
 *
 * Presentation only: `lib/room.ts` does the deriving, so this can be dropped
 * onto the live board in v2 without moving any logic.
 */

/** Positions read better as a phrase than as a slash-separated list. */
function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

/**
 * Why this team is worth a message — in the Laces register: second person,
 * plain, no jargon we haven't handed them.
 */
function why(fit: TradeFit): string {
  const { theyWant, iWant } = fit
  if (iWant.length && theyWant.length) {
    return `Deep at ${list(iWant)} where you're thin, and short at ${list(theyWant)} where you have spare.`
  }
  // Phrased as a clause rather than "the position(s) you need" so it reads
  // right whether one position matches or three.
  if (iWant.length) return `Spare ${list(iWant)}, which you still need.`
  if (theyWant.length) return `Short at ${list(theyWant)}, where you have spare.`
  return 'Balanced against you. Nothing obvious either way.'
}

function Chips({ team }: { team: TeamShape }) {
  return (
    <div className="room-chips">
      {(Object.keys(team.counts) as (keyof typeof team.counts)[])
        .filter((pos) => (team.counts[pos] ?? 0) > 0)
        .map((pos) => (
          <span
            key={pos}
            className={`chip pos-${String(pos).toLowerCase()}${team.surplus.includes(pos) ? ' active' : ''}`}
            style={{ cursor: 'default' }}
          >
            {pos} ×{team.counts[pos]}
          </span>
        ))}
      {/* A hole is a starting slot that isn't full, which is not the same as
          owning nobody there — one back when you start two is short, not
          empty, and labelling it "none" next to a visible "RB ×1" chip just
          reads as a bug. */}
      {team.holes.map((pos) => (
        <span key={`hole-${pos}`} className="chip room-hole" style={{ cursor: 'default' }}>
          {pos} — {(team.counts[pos] ?? 0) === 0 ? 'none' : 'short'}
        </span>
      ))}
    </div>
  )
}

export function TheRoom({
  room,
  fits,
  mySlot,
  /** Draft day passes a coverage caveat; a mock is complete by construction. */
  note,
}: {
  room: TeamShape[]
  fits: TradeFit[]
  mySlot: number
  note?: string
}) {
  const me = room.find((t) => t.slot === mySlot)
  const bySlot = new Map(room.map((t) => [t.slot, t]))

  return (
    <div className="room">
      <div className="mock-avail-head">
        <div className="stat-label">The room</div>
        <span className="ac-meta">sorted by trade fit</span>
      </div>
      <p className="ac-meta mock-hint">
        {note ??
          'Who is stacking what — and therefore who wants what you have. Ordered by how well each team fits yours, not by slot.'}
        {fits.length > 0 && fits[0].score === 0 &&
          ' Nobody has spare depth yet — fits show up once rosters fill out.'}
      </p>

      {me && (
        <div className="room-me">
          <div className="ac-meta">Your team — slot {me.slot}</div>
          <Chips team={me} />
        </div>
      )}

      <ul className="room-list">
        {fits.map((fit, i) => {
          const team = bySlot.get(fit.slot)
          if (!team) return null
          return (
            <li key={fit.slot} className={`room-row${fit.score === 0 ? ' room-quiet' : ''}`}>
              {/* Only rank what is actually ranked. Numbering a run of
                  scoreless teams 1, 2, 3 asserts an order the score doesn't
                  support — early in a draft nobody has surplus yet, so every
                  fit is 0 and the numbers would be pure noise dressed up as
                  a finding. */}
              <span
                className={`room-rank${i === 0 && fit.score > 0 ? ' top' : ''}${
                  fit.score === 0 ? ' room-rank-none' : ''
                }`}
                aria-hidden={fit.score === 0}
              >
                {fit.score > 0 ? i + 1 : '·'}
              </span>
              <div className="room-main">
                <div className="room-name">
                  {team.label}{' '}
                  <span className="ac-meta">· slot {team.slot}</span>
                </div>
                <Chips team={team} />
                <div className="room-why">{why(fit)}</div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
