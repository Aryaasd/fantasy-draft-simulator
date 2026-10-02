'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AdpBoard } from '@/lib/adp'
import type { ScoringType } from '@/lib/types'
import { draftPlan, type PlanCandidate } from '@/lib/plan'
import { PlayerFace, PosTag } from '@/components/PlayerFace'
import { InjuryFlag } from '@/components/InjuryFlag'

/**
 * The sheet you bring into the draft room.
 *
 * Deliberately not another mock. A mock is exploratory and answers "what if I
 * do this?"; with a 30-second clock nobody explores, they want something
 * already open on a second screen that says "you're up at 24, realistically
 * these are there, and this is the one you still need".
 *
 * So: no simulation, no clock, no interaction beyond changing your slot. It
 * recomputes instantly because `draftPlan` is pure — which also means you can
 * try a slot you might get and see the whole shape change.
 *
 * Every number is a prior, not a promise. The page says so once, plainly, at
 * the top rather than hedging on every row.
 */

const SCORING_LABEL: Record<ScoringType, string> = {
  ppr: 'PPR',
  half_ppr: 'Half PPR',
  standard: 'Standard',
}

function pct(n: number): number {
  return Math.round(n * 100)
}

/** Green when he'll keep, amber for a coin flip, red when he won't. */
function oddsClass(n: number): string {
  if (n >= 0.75) return 'odds odds-safe'
  if (n >= 0.4) return 'odds odds-mid'
  return 'odds odds-gone'
}

/**
 * Consensus rank is shown alongside the odds, and it is not decoration.
 *
 * Without it the sheet looks wrong: the pick reads 76% while the alternatives
 * under it read 97% and 98%, and the obvious question is why you'd take the
 * less likely one. Because he is better — the plan takes the best player
 * comfortably likely to be there, not the most likely, and everything is
 * ordered by consensus. The rank is what makes that visible instead of
 * looking arbitrary.
 */
function Candidate({ c }: { c: PlanCandidate }) {
  return (
    <span className="plan-alt">
      <PlayerFace id={c.player.id} pos={c.player.pos} team={c.player.team} size={20} />
      <span className="plan-alt-name">
        {c.player.name} <PosTag pos={c.player.pos} />{' '}
        <span className="ac-meta">#{c.consensus}</span>
      </span>
      <span className={oddsClass(c.availability)}>{pct(c.availability)}%</span>
    </span>
  )
}

export function DraftPlan({
  memberName,
  teams,
  rounds,
  slots,
  scoring: leagueScoring,
  initialPosition,
}: {
  memberName: string
  teams: number
  rounds: number
  slots: Record<string, number>
  scoring: ScoringType
  initialPosition: number | null
}) {
  const [slot, setSlot] = useState(initialPosition ?? 1)
  const [scoring, setScoring] = useState<ScoringType>(leagueScoring)
  const [board, setBoard] = useState<AdpBoard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async (fmt: ScoringType) => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch(`/api/adp?scoring=${fmt}`)
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'Could not load draft data')
      setBoard(j as AdpBoard)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load draft data')
    } finally {
      setLoading(false)
    }
  }, [])

  /* eslint-disable react-hooks/set-state-in-effect --
     Fetching the board once on mount is the external-system case. */
  useEffect(() => {
    void load(scoring)
    // Only on mount and on a deliberate scoring change; `load` is stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scoring])
  /* eslint-enable react-hooks/set-state-in-effect */

  const plan = useMemo(
    () => (board ? draftPlan({ board, slot, teams, rounds, slots }) : []),
    [board, slot, teams, rounds, slots],
  )

  return (
    <div className="plan">
      <div className="section-label">Draft plan</div>
      <h1 className="title">Know your picks before you&rsquo;re on the clock.</h1>
      <p className="subtitle">
        Where your picks land in a {teams}-team draft, and who the market says is
        realistically there when they do. Built to have open beside you — the
        clock is 30 seconds and this is the part you don&rsquo;t want to be
        working out live.
      </p>

      <div className="plan-controls">
        <label className="mock-field">
          <span className="stat-label">Your draft slot</span>
          <input
            className="input"
            type="number"
            min={1}
            max={teams}
            value={slot}
            onChange={(e) =>
              setSlot(Math.min(teams, Math.max(1, Number(e.target.value) || 1)))
            }
          />
        </label>
        <div>
          <span className="stat-label">Scoring</span>
          <div className="mock-bar" style={{ marginTop: '0.4rem' }}>
            {(['ppr', 'half_ppr', 'standard'] as ScoringType[]).map((s) => (
              <button
                key={s}
                type="button"
                className={`chip${scoring === s ? ' active' : ''}`}
                onClick={() => setScoring(s)}
                aria-pressed={scoring === s}
              >
                {SCORING_LABEL[s]}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Said once, plainly, rather than hedged on every row. */}
      <p className="disclosure plan-caveat">
        <strong>#</strong> is where the market has a player going overall;{' '}
        <strong>%</strong> is how likely he is to still be there at your pick. The
        plan takes the best player who&rsquo;s comfortably likely to last — not
        the likeliest, which would just hand you the worst player on the board.
        These are odds, not promises: a row saying 80% will be wrong about one
        pick in five, and it can&rsquo;t see a run coming, only where people
        normally go. Change your slot above to watch the whole thing shift.
      </p>

      {error && <div className="error">{error}</div>}
      {loading && !board && <div className="empty">Loading current draft data…</div>}

      {board && (
        <>
          <ol className="plan-list">
            {plan.map((p) => (
              <li key={p.round} className="plan-round">
                <div className="plan-head">
                  <span className="plan-round-no">R{p.round}</span>
                  <span className="plan-pick">pick #{p.overall}</span>
                  <span className="ac-meta plan-needs">
                    {p.stillNeeded.length
                      ? `still need ${p.stillNeeded.join(', ')}`
                      : 'lineup complete'}
                  </span>
                </div>

                {p.take ? (
                  <div className="plan-take">
                    <PlayerFace
                      id={p.take.player.id}
                      pos={p.take.player.pos}
                      team={p.take.player.team}
                      size={30}
                    />
                    <div className="plan-take-who">
                      <strong>{p.take.player.name}</strong>{' '}
                      <span className="ac-meta">
                        <PosTag pos={p.take.player.pos} /> · {p.take.player.team} ·
                        consensus #{p.take.consensus}
                      </span>
                      {p.take.player.injury && (
                        <>
                          {' '}
                          <InjuryFlag status={p.take.player.injury} />
                        </>
                      )}
                    </div>
                    <span className={oddsClass(p.take.availability)}>
                      {pct(p.take.availability)}%
                    </span>
                  </div>
                ) : (
                  <div className="plan-take plan-take-empty">
                    <span className="ac-meta">Nothing the market still rates here.</span>
                  </div>
                )}

                {p.likely.length > 0 && (
                  <div className="plan-row">
                    <span className="plan-label">also there</span>
                    <span className="plan-alts">
                      {p.likely.map((c) => (
                        <Candidate key={c.player.id} c={c} />
                      ))}
                    </span>
                  </div>
                )}

                {p.stretch.length > 0 && (
                  <div className="plan-row">
                    <span className="plan-label plan-label-hope">if he falls</span>
                    <span className="plan-alts">
                      {p.stretch.map((c) => (
                        <Candidate key={c.player.id} c={c} />
                      ))}
                    </span>
                  </div>
                )}
              </li>
            ))}
          </ol>


          <p className="disclosure">
            {memberName}, this is built from {board.meta.totalDrafts.toLocaleString()}{' '}
            real drafts run {board.meta.startDate} → {board.meta.endDate}. It moves
            every day, so check it again the morning of the draft.
          </p>
        </>
      )}
    </div>
  )
}
