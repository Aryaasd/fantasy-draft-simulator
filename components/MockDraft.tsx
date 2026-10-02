'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { AdpBoard, AdpEntry, MarketPlayer } from '@/lib/adp'
import type { FantasyPos } from '@/lib/players'
import type { ScoringType } from '@/lib/types'
import {
  detectRun,
  nextPickForMe,
  roundAndPick,
  rosterNeeds,
  slotForOverall,
} from '@/lib/draft'
import { simulateAdpPick, survivalOdds } from '@/lib/mock'
import { assignLineup } from '@/lib/lineup'
import { analyzeDraft } from '@/lib/analysis'
import { suggestPicks } from '@/lib/suggest'
import { PickAdvice } from '@/components/PickAdvice'
import { DraftReport } from '@/components/DraftReport'
import { Lineup } from '@/components/Lineup'
import { readTheRoom, tradeFits } from '@/lib/room'
import { TheRoom } from '@/components/TheRoom'
import { InjuryFlag } from '@/components/InjuryFlag'
import { PlayerFace, PosTag } from '@/components/PlayerFace'
import { flaggedPlayers, rosterHealthLine } from '@/lib/injury'

interface Props {
  memberName: string
  /** League defaults — every one of them is editable before starting. */
  teams: number
  rounds: number
  slots: Record<string, number>
  scoring: ScoringType
  initialPosition: number | null
}

interface MockPick {
  playerId: string
  overall: number
}

const POS_FILTERS: (FantasyPos | 'ALL')[] = ['ALL', 'RB', 'WR', 'QB', 'TE', 'K', 'DEF']

/**
 * Pacing.
 *
 * A single flat delay is wrong in both directions at once. In a 12-team league
 * there are 22 picks between your turns, so at one speed you either sit through
 * the middle of every round or the picks that decide your options flash past
 * unread — and it was the second: 22 picks in about three seconds.
 *
 * So the tick follows the shape of the draft. It moves briskly through picks
 * that don't concern you, slows over the run-in to your turn — those are the
 * ones that determine who is actually left — and takes a beat after your own
 * pick so the board has a moment to settle before it starts moving again.
 *
 * Anyone who wants none of this has "Skip to my pick", which resolves every
 * intervening pick at once.
 */
const TICK_BASE = 240
const TICK_NEAR = 520
const TICK_AFTER_YOURS = 950

/** How many picks out counts as the run-in to your turn. */
const RUN_IN = 5

/**
 * How fast the room drafts, as a multiplier on the ticks above.
 *
 * Pacing is taste, not a fact — how long someone wants to watch a pick land
 * depends entirely on whether they are studying the board or just want their
 * next turn. Rather than guess a single number, the shape stays fixed and the
 * speed is the member's to set. Remembered, because nobody wants to choose it
 * again every mock.
 */
const SPEEDS = { relaxed: 1.9, normal: 1, brisk: 0.45 } as const
type Speed = keyof typeof SPEEDS
const SPEED_KEY = 'laces_mock_speed'
const SPEED_LABEL: Record<Speed, string> = {
  relaxed: 'Relaxed',
  normal: 'Normal',
  brisk: 'Brisk',
}

const SCORING_LABEL: Record<ScoringType, string> = {
  ppr: 'PPR',
  half_ppr: 'Half PPR',
  standard: 'Standard',
}

export function MockDraft({
  memberName,
  teams: leagueTeams,
  rounds: leagueRounds,
  slots,
  scoring: leagueScoring,
  initialPosition,
}: Props) {
  // --- setup -------------------------------------------------------------
  const [started, setStarted] = useState(false)
  const [teams, setTeams] = useState(leagueTeams)
  const [slot, setSlot] = useState(initialPosition ?? 1)
  const [rounds, setRounds] = useState(leagueRounds)
  const [scoring, setScoring] = useState<ScoringType>(leagueScoring)

  // --- board -------------------------------------------------------------
  const [board, setBoard] = useState<AdpBoard | null>(null)
  const [boardError, setBoardError] = useState<string | null>(null)
  const [loadingBoard, setLoadingBoard] = useState(false)

  // --- draft -------------------------------------------------------------
  const [picks, setPicks] = useState<MockPick[]>([])
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState<FantasyPos | 'ALL'>('ALL')
  /**
   * null means "nobody has decided yet", which resolves to closed while the
   * draft runs and open once it finishes. Derived rather than flipped in an
   * effect — an effect would cost a second render just to reach the state we
   * can compute, and would fight the user the moment they closed it.
   */
  const [roomOpen, setRoomOpen] = useState<boolean | null>(null)
  const [speed, setSpeed] = useState<Speed>('normal')

  /* eslint-disable react-hooks/set-state-in-effect --
     Reading a stored preference once on mount is the exempt case. */
  useEffect(() => {
    try {
      const saved = localStorage.getItem(SPEED_KEY)
      if (saved && saved in SPEEDS) setSpeed(saved as Speed)
    } catch {
      /* a browser refusing storage shouldn't cost you the draft */
    }
  }, [])
  /* eslint-enable react-hooks/set-state-in-effect */

  const chooseSpeed = useCallback((s: Speed) => {
    setSpeed(s)
    try {
      localStorage.setItem(SPEED_KEY, s)
    } catch {
      /* ignore */
    }
  }, [])

  // --- what the dock sees ------------------------------------------------
  const [error, setError] = useState<string | null>(null)

  // --- board load --------------------------------------------------------

  const loadBoard = useCallback(async (fmt: ScoringType) => {
    setLoadingBoard(true)
    setBoardError(null)
    try {
      const res = await fetch(`/api/adp?scoring=${fmt}`)
      const j = await res.json()
      if (!res.ok) throw new Error(j.error ?? 'Could not load draft data')
      setBoard(j as AdpBoard)
    } catch (e) {
      setBoardError(e instanceof Error ? e.message : 'Could not load draft data')
    } finally {
      setLoadingBoard(false)
    }
  }, [])

  // --- derived -----------------------------------------------------------

  // Memoized because `?? []` would be a fresh array each render, invalidating
  // every downstream memo and re-arming the simulation timer on every tick.
  const entries = useMemo(() => board?.entries ?? [], [board])
  const byId = useMemo(
    () => new Map(entries.map((e) => [e.player.id, e])),
    [entries],
  )
  const taken = useMemo(() => new Set(picks.map((p) => p.playerId)), [picks])

  const totalPicks = teams * rounds
  const currentOverall = picks.length + 1
  const complete = picks.length >= totalPicks
  const { round, pick } = roundAndPick(Math.min(currentOverall, totalPicks), teams)
  const onClock = !complete && slotForOverall(currentOverall, teams) === slot

  const myPlayers = useMemo(
    () =>
      picks
        .filter((p) => slotForOverall(p.overall, teams) === slot)
        .map((p) => byId.get(p.playerId)?.player)
        .filter((p): p is MarketPlayer => !!p),
    [picks, slot, teams, byId],
  )

  /**
   * My roster as a starting lineup.
   *
   * Built from `picks` rather than `myPlayers` so the round is the pick's real
   * round. Indexing myPlayers happens to agree today — one pick per round — but
   * it would quietly go wrong the moment anything skips a turn.
   *
   * Ordered by ADP including the synthetic tail. That number is not a VALUE
   * past the observed market (see the gate in the analyzer), but it is a
   * perfectly good ORDERING: the tail continues the board in Sleeper rank, so
   * it still sorts a depth chart correctly.
   */
  const myEntries = useMemo(
    () =>
      picks
        .filter((p) => slotForOverall(p.overall, teams) === slot)
        .map((p) => {
          const e = byId.get(p.playerId)
          return e
            ? {
                player: e.player,
                round: roundAndPick(p.overall, teams).round,
                order: e.adp,
              }
            : null
        })
        .filter((e): e is { player: MarketPlayer; round: number; order: number } => !!e),
    [picks, slot, teams, byId],
  )

  const myLineup = useMemo(() => assignLineup(myEntries, slots), [myEntries, slots])

  const needs = useMemo(() => rosterNeeds(slots, myPlayers), [slots, myPlayers])

  const recent = useMemo(
    () =>
      picks
        .slice(-12)
        .map((p) => ({ entry: byId.get(p.playerId), overall: p.overall }))
        .filter((r): r is { entry: AdpEntry; overall: number } => !!r.entry)
        .reverse(),
    [picks, byId],
  )

  const run = useMemo(
    () => detectRun(recent.map((r) => r.entry.player).reverse()),
    [recent],
  )

  const showRoom = roomOpen ?? complete

  /**
   * Every team's shape, not just mine.
   *
   * Only computed when the panel is actually on screen: it walks all 270 picks
   * and the simulation re-renders on every one of them.
   */
  const room = useMemo(
    () =>
      showRoom
        ? readTheRoom({
            picks,
            teams,
            slots,
            lookup: (id) => byId.get(id)?.player,
            mySlot: slot,
          })
        : [],
    [showRoom, picks, teams, slots, byId, slot],
  )

  /**
   * The finished draft, read back.
   *
   * Gated on `complete` for the same reason `room` is: it ranks all eighteen
   * starting lineups and walks the whole pick list, and the simulation
   * re-renders on every one of 270 picks.
   */
  const report = useMemo(
    () =>
      complete && board
        ? analyzeDraft({ picks, board, teams, slot, rounds, slots })
        : null,
    [complete, board, picks, teams, slot, rounds, slots],
  )

  const fits = useMemo(
    () => (showRoom ? tradeFits(room, slot) : []),
    [showRoom, room, slot],
  )

  /** The turn after this one — what "will he still be there?" is measured against. */
  const myNextAfterThis = useMemo(
    () => nextPickForMe(currentOverall + (onClock ? 1 : 0), slot, teams, rounds),
    [currentOverall, onClock, slot, teams, rounds],
  )

  /**
   * Who to take right now.
   *
   * Gated on `onClock` for the same reason the report is gated on `complete`:
   * it scans the board per position and the simulation re-renders on every one
   * of 270 picks. Off the clock there is nothing to advise about anyway.
   */
  const advice = useMemo(
    () =>
      onClock && entries.length > 0
        ? suggestPicks({
            entries,
            taken,
            myPlayers,
            slots,
            currentOverall,
            nextOverall: myNextAfterThis?.overall ?? null,
            round,
            totalRounds: rounds,
          })
        : null,
    [onClock, entries, taken, myPlayers, slots, currentOverall, myNextAfterThis, round, rounds],
  )


  /**
   * Kickers and defenses are hidden from the unfiltered board until the end.
   *
   * Not cosmetic. Opponents don't touch them until the last two rounds, so they
   * sit untaken while every skill player around them comes off — and by round
   * six the best "available ADP" on the board is a defense. Left in, the list
   * recommends a round-six defense, which is how you end a mock with seven of
   * them. The K and DEF chips still show them for anyone who wants one early.
   */
  const hideLateOnly = round <= rounds - 2

  const available = useMemo(() => {
    const out: AdpEntry[] = []
    for (const e of entries) {
      if (taken.has(e.player.id)) continue
      const lateOnly = e.player.pos === 'K' || e.player.pos === 'DEF'
      if (filter === 'ALL' ? hideLateOnly && lateOnly : e.player.pos !== filter) continue
      out.push(e)
      if (out.length >= 60) break
    }
    return out
  }, [entries, taken, filter, hideLateOnly])

  // --- the simulation loop ----------------------------------------------

  /**
   * One opponent pick per tick.
   *
   * The choice is computed here rather than inside the `setPicks` updater
   * because it's random: React can invoke an updater twice, and a second roll
   * would quietly disagree with the first. Updaters have to be pure, so the
   * randomness happens once, outside.
   */
  const opponentPick = useCallback(() => {
    const overall = picks.length + 1
    const owner = slotForOverall(overall, teams)
    const roster = picks
      .filter((p) => slotForOverall(p.overall, teams) === owner)
      .map((p) => byId.get(p.playerId)?.player)
      .filter((p): p is MarketPlayer => !!p)

    const choice = simulateAdpPick(entries, taken, roster, {
      slots,
      round: roundAndPick(overall, teams).round,
      totalRounds: rounds,
    })
    if (choice) setPicks((prev) => [...prev, { playerId: choice.player.id, overall }])
  }, [picks, teams, byId, entries, taken, slots, rounds])

  /**
   * How long to wait before the next simulated pick.
   *
   * Derived rather than stored, so it cannot fall out of step with the board.
   */
  const tick = useMemo(() => {
    const mult = SPEEDS[speed]
    const last = picks[picks.length - 1]
    if (last && slotForOverall(last.overall, teams) === slot) return TICK_AFTER_YOURS * mult
    const until = myNextAfterThis ? myNextAfterThis.overall - currentOverall : Infinity
    return (until <= RUN_IN ? TICK_NEAR : TICK_BASE) * mult
  }, [picks, teams, slot, myNextAfterThis, currentOverall, speed])

  /** Picks between now and your turn — shown so the pacing reads as deliberate. */
  const picksUntilMine = myNextAfterThis
    ? myNextAfterThis.overall - currentOverall
    : null

  /* eslint-disable react-hooks/exhaustive-deps --
     Depending on `opponentPick` would re-arm the timer on every board mutation
     it closes over, which is every pick — the gate is picks.length, and that's
     what should drive it. */
  useEffect(() => {
    if (!started || complete || onClock || paused) return
    if (entries.length === 0) return
    const t = setTimeout(opponentPick, tick)
    return () => clearTimeout(t)
  }, [started, complete, onClock, paused, entries.length, picks.length, tick])
  /* eslint-enable react-hooks/exhaustive-deps */

  /**
   * Run every pick between here and the user's turn in one go.
   *
   * Each simulated team has to see the previous pick, so this walks a single
   * evolving snapshot rather than calling the per-tick path in a loop.
   */
  function skipToMyPick() {
    if (entries.length === 0) return
    setPicks((prev) => {
      const next = [...prev]
      const takenIds = new Set(next.map((p) => p.playerId))
      while (next.length < totalPicks) {
        const overall = next.length + 1
        if (slotForOverall(overall, teams) === slot) break
        const owner = slotForOverall(overall, teams)
        const roster = next
          .filter((p) => slotForOverall(p.overall, teams) === owner)
          .map((p) => byId.get(p.playerId)?.player)
          .filter((p): p is MarketPlayer => !!p)
        const choice = simulateAdpPick(entries, takenIds, roster, {
          slots,
          round: roundAndPick(overall, teams).round,
          totalRounds: rounds,
        })
        if (!choice) break
        takenIds.add(choice.player.id)
        next.push({ playerId: choice.player.id, overall })
      }
      return next
    })
  }

  function draftPlayer(e: AdpEntry) {
    if (!onClock) return
    setPicks((prev) => [...prev, { playerId: e.player.id, overall: prev.length + 1 }])
  }

  /**
   * Take back your last pick.
   *
   * The draft-day board has had undo since it shipped; the mock never did, so
   * a misclick on a sixty-row list could only be undone by restarting all 270
   * picks — in the one surface whose entire purpose is that mistakes are free.
   *
   * Rewinds to the moment you were on the clock, dropping the opponent picks
   * that followed. Those re-simulate, and they will NOT repeat exactly: each
   * opponent re-rolls against its own ADP spread. That is right for a
   * rehearsal — the point is to try a different branch and see what comes
   * back, not to replay a fixed script.
   */
  function undoMyPick() {
    setPicks((prev) => {
      for (let i = prev.length - 1; i >= 0; i--) {
        if (slotForOverall(prev[i].overall, teams) === slot) return prev.slice(0, i)
      }
      return prev
    })
    setPaused(false)
  }

  async function start() {
    setPicks([])
    setError(null)
    setStarted(true)
    if (!board || board.meta.format !== formatKey(scoring)) await loadBoard(scoring)
  }

  function restart() {
    setStarted(false)
    setPicks([])
    setPaused(false)
  }

  /** Flags on the team you just built, worst first. */
  const flagged = useMemo(() => flaggedPlayers(myPlayers), [myPlayers])
  const healthLine = rosterHealthLine(flagged)


  // --- render: setup -----------------------------------------------------

  if (!started) {
    return (
      <div className="mock-setup">
        <div className="section-label">Mock draft</div>
        <h1 className="title">Rehearse the draft you&rsquo;re actually in.</h1>
        <p className="subtitle">
          The other 17 teams draft themselves, off what people are really taking
          this week. Pick your slot and find out who actually reaches you.
        </p>

        <div className="mock-fields">
          <label className="mock-field">
            <span className="stat-label">Teams in the league</span>
            <input
              className="input"
              type="number"
              min={2}
              max={20}
              value={teams}
              onChange={(e) => {
                const n = Math.min(20, Math.max(2, Number(e.target.value) || 2))
                setTeams(n)
                setSlot((s) => Math.min(s, n))
              }}
            />
          </label>

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

          <label className="mock-field">
            <span className="stat-label">Rounds</span>
            <input
              className="input"
              type="number"
              min={1}
              max={20}
              value={rounds}
              onChange={(e) =>
                setRounds(Math.min(20, Math.max(1, Number(e.target.value) || 1)))
              }
            />
          </label>
        </div>

        <div className="stat-label" style={{ marginTop: '1.25rem' }}>
          Scoring
        </div>
        <div className="mock-bar" style={{ marginTop: '0.5rem' }}>
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

        <button className="btn" type="button" onClick={start} disabled={loadingBoard}>
          {loadingBoard ? 'Loading draft data…' : 'Start mock draft →'}
        </button>

        {boardError && <div className="error">{boardError}</div>}

        <p className="disclosure">
          Your opponents draft from live average draft position — real drafts
          from the past week, not last season&rsquo;s rankings. Questions you ask
          during a mock get saved like any other, tagged as practice.
        </p>
      </div>
    )
  }

  // --- render: loading ---------------------------------------------------

  if (loadingBoard || entries.length === 0) {
    return (
      <div className="empty">
        {boardError ? (
          <>
            <div className="error">{boardError}</div>
            <button className="btn-ghost" type="button" onClick={restart}>
              ← Back
            </button>
          </>
        ) : (
          'Loading current draft data…'
        )}
      </div>
    )
  }

  // --- render: draft -----------------------------------------------------

  const nextTurn = myNextAfterThis?.overall ?? null

  return (
    <div className="draft">
      <div className="draft-head">
        <div>
          <div className="section-label" style={{ marginBottom: '0.3rem' }}>
            Round {round} · Pick {pick} · Overall {Math.min(currentOverall, totalPicks)}{' '}
            of {totalPicks}
          </div>
          {complete ? (
            <div className="until">Draft complete</div>
          ) : onClock ? (
            <div className="on-clock">You&rsquo;re on the clock</div>
          ) : (
            <div className="until">
              Team {slotForOverall(currentOverall, teams)} picking…
              {picksUntilMine !== null && picksUntilMine > 0 && (
                <span className="ac-meta">
                  {' '}· you&rsquo;re up in {picksUntilMine}{' '}
                  {picksUntilMine === 1 ? 'pick' : 'picks'}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="draft-pos">
          <span className="ac-meta">
            Slot {slot} of {teams} · {SCORING_LABEL[scoring]}
          </span>
        </div>
      </div>

      <div className="mock-bar">
        {!complete && !onClock && (
          <>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => setPaused((p) => !p)}
            >
              {paused ? '▶ Resume' : '❚❚ Pause'}
            </button>
            <button type="button" className="btn-ghost" onClick={skipToMyPick}>
              Skip to my pick →
            </button>
          </>
        )}
        {myPlayers.length > 0 && !complete && (
          <button type="button" className="btn-ghost" onClick={undoMyPick}>
            ↺ undo my last pick
          </button>
        )}
        {!complete && (
          <span className="mock-speed">
            {(Object.keys(SPEEDS) as Speed[]).map((s) => (
              <button
                key={s}
                type="button"
                className={`chip${speed === s ? ' active' : ''}`}
                onClick={() => chooseSpeed(s)}
                aria-pressed={speed === s}
              >
                {SPEED_LABEL[s]}
              </button>
            ))}
          </span>
        )}
        <button
          type="button"
          className="btn-ghost"
          onClick={() => setRoomOpen(!showRoom)}
          aria-expanded={showRoom}
        >
          {showRoom ? 'Hide the room' : 'The room →'}
        </button>
        <button type="button" className="btn-ghost" onClick={restart}>
          ↻ New mock
        </button>
        {board && (
          <span className="ac-meta">
            ADP from {board.meta.totalDrafts.toLocaleString()} drafts,{' '}
            {board.meta.startDate} → {board.meta.endDate}
          </span>
        )}
      </div>

      {error && <div className="error">{error}</div>}

      {run && (
        <div className="run-warn">
          ⚡ Run on {run.pos} — {run.count} of the last {run.window} picks. Tier is
          thinning.
        </div>
      )}

      {advice && (
        <PickAdvice
          advice={advice}
          nextOverall={myNextAfterThis?.overall ?? null}
          onDraft={(id) => {
            const e = byId.get(id)
            if (e) draftPlayer(e)
          }}
        />
      )}

      <div className="mock-grid">
        {/* Best available */}
        <div>
          <div className="mock-avail-head">
            <div className="stat-label">
              {complete ? 'Left on the board' : onClock ? 'Take one' : 'Best available'}
            </div>
            <div className="mock-filters">
              {POS_FILTERS.map((f) => (
                <button
                  key={f}
                  type="button"
                  className={`chip${filter === f ? ' active' : ''}`}
                  onClick={() => setFilter(f)}
                  aria-pressed={filter === f}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          {nextTurn && !complete && (
            <p className="ac-meta mock-hint">
              {onClock
                ? `“Then?” is the odds each player is still there at your next pick (#${nextTurn}) — the reason to take one now instead of waiting.`
                : `Your next pick is #${nextTurn}.`}
              {filter === 'ALL' && hideLateOnly && ' Kickers and defenses are under their own tabs until the last two rounds.'}
            </p>
          )}

          <ul className="mock-list">
            {/* Labels the odds column the hint above refers to. */}
            <li className="mock-row mock-row-head" aria-hidden="true">
              <div className="mock-row-main">Player</div>
              <div className="mock-row-adp">Going at</div>
              <div className="mock-row-odds">{nextTurn ? 'Then?' : ''}</div>
              <div className="mock-row-act" />
            </li>
            {available.map((e) => {
              const odds = nextTurn
                ? survivalOdds(e, currentOverall, nextTurn)
                : null
              return (
                <li key={e.player.id} className="mock-row">
                  <div className="mock-row-main">
                    <PlayerFace id={e.player.id} pos={e.player.pos} team={e.player.team} size={24} />
                    <span className="mock-row-who">
                      <strong>{e.player.name}</strong>{' '}
                      <span className="ac-meta">
                        <PosTag pos={e.player.pos} /> · {e.player.team}
                      </span>
                      {e.player.injury && (
                        <>
                          {' '}
                          <InjuryFlag status={e.player.injury} />
                        </>
                      )}
                    </span>
                  </div>
                  <div className="mock-row-adp">
                    {e.observed ? (
                      <span className="ac-meta">ADP {e.adp.toFixed(1)}</span>
                    ) : (
                      <span className="ac-meta" title="Past the range real drafts cover">
                        undrafted
                      </span>
                    )}
                  </div>
                  <div className="mock-row-odds">
                    {odds !== null && (
                      <span className={oddsClass(odds)}>{Math.round(odds * 100)}%</span>
                    )}
                  </div>
                  <div className="mock-row-act">
                    {onClock && (
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => draftPlayer(e)}
                        style={{ marginTop: 0, padding: '0.3rem 0.75rem', fontSize: '0.78rem' }}
                      >
                        Draft
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
            {available.length === 0 && <li className="ac-meta">Nobody left here.</li>}
          </ul>
        </div>

        {/* Your team + feed */}
        <div>
          <div className="stat-label">
            {memberName}&rsquo;s team ({myPlayers.length})
          </div>
          <div className="needs">
            {needs.map((s) => (
              <span
                key={s.slot}
                className={`chip${s.filled >= s.need ? ' active' : ''}`}
                style={{ cursor: 'default' }}
              >
                {s.slot} {s.filled}/{s.need}
              </span>
            ))}
          </div>
          <Lineup lineup={myLineup} />

          {healthLine && <div className="health-note">{healthLine}</div>}

          <div className="stat-label" style={{ marginTop: '1.5rem' }}>
            Last off the board
          </div>
          <ul className="roster">
            {recent.map(({ entry, overall }) => (
              <li key={overall}>
                <span className="ac-meta">#{overall}</span> {entry.player.name}{' '}
                <PosTag pos={entry.player.pos} />
              </li>
            ))}
            {recent.length === 0 && <li className="ac-meta">Not started.</li>}
          </ul>
        </div>
      </div>

      {report && (
        <DraftReport report={report} />
      )}

      {showRoom && <TheRoom room={room} fits={fits} mySlot={slot} />}
    </div>
  )
}

/** Green when he'll keep, amber when it's a coin flip, red when he won't. */
function oddsClass(odds: number): string {
  if (odds >= 0.66) return 'odds odds-safe'
  if (odds >= 0.33) return 'odds odds-mid'
  return 'odds odds-gone'
}

function formatKey(s: ScoringType): string {
  return s === 'half_ppr' ? 'half-ppr' : s
}
