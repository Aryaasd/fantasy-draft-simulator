'use client'

import type { DraftReport } from '@/lib/analysis'

/**
 * The draft you just ran, read back to you.
 *
 * Presentation only — `lib/analysis.ts` does every derivation, the same split
 * as `lib/room.ts` / `TheRoom.tsx`. That means this renders a report from a
 * parsed Yahoo screenshot exactly as happily as one from the simulator.
 *
 * Every finding is also a question you can tap. Those go through the normal
 * instrumented path marked `canned` — the phrasing is ours, not the member's,
 * and scoring our own sentences for sophistication would corrupt Q3 exactly as
 * migration 0004 spells out.
 */

function ordinal(n: number): string {
  const rem100 = n % 100
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`
  switch (n % 10) {
    case 1: return `${n}st`
    case 2: return `${n}nd`
    case 3: return `${n}rd`
    default: return `${n}th`
  }
}

/** Positions read better as a phrase than a slash-separated list. */
function list(items: string[]): string {
  if (items.length <= 1) return items[0] ?? ''
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`
}

/** Below this the market barely disagreed with you, and saying so is noise. */
const NOTABLE_GAP = 5

export function DraftReport({ report }: { report: DraftReport }) {
  const { grade, rankOfField, teams, cappedBy, unfilled, steal, reach, depth, passedOn } = report

  const notable = passedOn.filter((p) => p.gap >= NOTABLE_GAP).slice(0, 3)

  /**
   * Where you hold fewer bodies than almost anyone else.
   *
   * This counts players, not quality, so it is a statement about cover rather
   * than about your starters — you can have the best two backs in the league
   * and still be last for depth. In an 18-team league that matters: the waiver
   * wire is barren, so an injury has nowhere to be solved from.
   */
  const thin = depth
    .filter((d) => d.pos !== 'K' && d.pos !== 'DEF' && d.rank > teams * 0.66)
    .sort((a, b) => b.rank - a.rank)

  return (
    <div className="report">
      <div className="mock-avail-head">
        <div className="stat-label">Your draft</div>
        <span className="ac-meta">against the {teams - 1} teams you drafted against</span>
      </div>

      <div className="report-grade">
        <div className="report-letter">{grade}</div>
        <div className="report-grade-body">
          <div className="report-rank">
            {ordinal(rankOfField)} of {teams} on your starting lineup
          </div>
          {/* Say what the number measures. It ranks your starters by where the
              market has them going — it is not a points projection, and
              implying otherwise would be the confident-wrong answer the whole
              app is built to avoid. */}
          <p className="ac-meta">
            Ranked by where the market has your starters going, against the same
            slot on every other team. It measures the squad you built, not the
            points it will score.
          </p>
          {cappedBy ? (
            <div className="report-capped">
              Held at {grade} because you finished without {list(cappedBy)}. An
              empty starting slot is a zero in that position every week, however
              good the rest of the team is.
            </div>
          ) : unfilled.length > 0 ? (
            <div className="report-capped">
              You finished without {list(unfilled)}. An empty starting slot is a
              zero in that position every week.
            </div>
          ) : null}
        </div>
      </div>

      <ul className="report-findings">
        {steal && (
          <li className="report-finding">
            <span className="report-tag report-good">Best value</span>
            <div>
              <strong>{steal.player.name}</strong> at #{steal.overall}. Consensus
              had him going around #{Math.round(steal.adp)} — he slid{' '}
              {Math.round(steal.slide)} picks to you.
            </div>
          </li>
        )}

        {reach && (
          <li className="report-finding">
            <span className="report-tag report-warn">Biggest reach</span>
            <div>
              <strong>{reach.player.name}</strong> at #{reach.overall}, about{' '}
              {Math.abs(Math.round(reach.slide))} picks ahead of where the board
              had him.
            </div>
          </li>
        )}

        {notable.map((p) => (
          <li key={p.atOverall} className="report-finding">
            <span className="report-tag">#{p.atOverall}</span>
            <div>
              You took <strong>{p.tookInstead.name}</strong> over{' '}
              <strong>{p.player.name}</strong>.{' '}
              {p.survived ? (
                <>
                  {p.player.name.split(' ').slice(-1)[0]} was still there at your
                  next pick
                  {p.nextOverall ? ` (#${p.nextOverall})` : ''} — you could have
                  had both.
                </>
              ) : (
                <>
                  {p.player.name.split(' ').slice(-1)[0]} went{' '}
                  {p.wentAt! - p.atOverall} picks later — waiting would not have
                  worked.
                </>
              )}
            </div>
          </li>
        ))}

        {thin.length > 0 && (
          <li className="report-finding">
            <span className="report-tag report-warn">Cover</span>
            <div>
              {thin
                .map((d) => `${d.pos} — ${ordinal(d.rank)} of ${teams} for bodies`)
                .join(' · ')}
              . Your starters may be fine; this is about what happens if one
              goes down, and in a league this deep the waiver wire won&rsquo;t
              save you.
            </div>
          </li>
        )}
      </ul>

    </div>
  )
}
