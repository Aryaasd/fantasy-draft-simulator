'use client'

import { useEffect, useState } from 'react'
import type { Advice, PositionCase } from '@/lib/suggest'
import { InjuryFlag } from '@/components/InjuryFlag'
import { PlayerFace, PosTag } from '@/components/PlayerFace'

/**
 * What to do with the pick you are on — offered, never insisted on.
 *
 * Collapsed to a single line by default. This is a tool you reach for when you
 * want it, not a coach talking over your draft: the board is the page, your
 * pick is your business, and a panel that fills the screen every turn would be
 * telling you what to do rather than being available if you ask. Opening it is
 * one click and the choice sticks.
 *
 * Presentation only — `lib/suggest.ts` does the reasoning. Every number shown
 * here is checkable against the board on screen, which is the whole design
 * constraint: advice you cannot audit is indistinguishable from a guess, and
 * this is aimed at people who have been told "just take the best player
 * available" and never told what that means when they have four receivers.
 */

/** Remembered per browser, so the choice to open it holds across picks. */
const OPEN_KEY = 'laces_advice_open'

const POS_NOUN: Record<string, string> = {
  QB: 'quarterback',
  RB: 'running back',
  WR: 'receiver',
  TE: 'tight end',
  K: 'kicker',
  DEF: 'defense',
}

function noun(pos: string): string {
  return POS_NOUN[pos] ?? pos
}

function pct(n: number): number {
  return Math.round(n * 100)
}

/**
 * The case for taking this position now, in plain language.
 *
 * Three genuinely different situations, and conflating them is what makes most
 * draft tools useless: the tier is about to break, the player is about to go,
 * or nothing is urgent and you are simply taking the best thing left.
 */
function because(c: PositionCase, nextOverall: number | null): string {
  const gone = pct(1 - c.survival)
  const drop = Math.round(c.dropoff)

  if (!nextOverall) {
    return `Last pick, so there is no waiting — he is the best ${noun(c.pos)} left.`
  }
  if (!c.fallback) {
    return `There is no ${noun(c.pos)} behind him you could count on getting back at #${nextOverall}. It is him or nobody.`
  }
  if (gone >= 60 && drop >= 12) {
    return `Only ${100 - gone}% to reach your next pick at #${nextOverall}, and the ${noun(c.pos)} you would fall back to is ${drop} spots further down the board.`
  }
  if (drop >= 20) {
    return `The drop after him is steep — ${drop} spots to the next ${noun(c.pos)} you would likely still get at #${nextOverall}.`
  }
  if (gone >= 60) {
    return `He is ${gone}% likely to be gone by #${nextOverall}, and there is no cheaper time to take him than now.`
  }
  return `Best ${noun(c.pos)} available, and the board is not forcing your hand anywhere else.`
}

function Row({ c, nextOverall }: { c: PositionCase; nextOverall: number | null }) {
  return (
    <li className="advice-alt">
      <PosTag pos={c.pos} className="advice-alt-pos" />
      <PlayerFace id={c.best.player.id} pos={c.best.player.pos} team={c.best.player.team} size={20} />
      <div>
        <strong>{c.best.player.name}</strong>{' '}
        <span className="ac-meta">{c.best.player.team}</span>
        {c.best.player.injury && (
          <>
            {' '}
            <InjuryFlag status={c.best.player.injury} />
          </>
        )}
        {nextOverall && (
          <span className="ac-meta"> · {pct(c.survival)}% to last</span>
        )}
      </div>
    </li>
  )
}

export function PickAdvice({
  advice,
  nextOverall,
  onDraft,
}: {
  advice: Advice
  nextOverall: number | null
  onDraft: (playerId: string) => void
}) {
  const [open, setOpen] = useState(false)

  /* eslint-disable react-hooks/set-state-in-effect --
     Reading a stored preference once on mount is the exempt case. */
  useEffect(() => {
    try {
      if (localStorage.getItem(OPEN_KEY) === '1') setOpen(true)
    } catch {
      /* a browser refusing storage shouldn't cost you the panel */
    }
  }, [])
  /* eslint-enable react-hooks/set-state-in-effect */

  const toggle = () => {
    setOpen((v) => {
      try {
        localStorage.setItem(OPEN_KEY, v ? '0' : '1')
      } catch {
        /* ignore */
      }
      return !v
    })
  }

  const { take, alternatives, canWait, starterComplete } = advice
  if (!take) return null

  const p = take.best.player

  return (
    <div className={`advice${open ? ' advice-open' : ''}`}>
      {/* The whole strip is the control. One line, one click, no commitment. */}
      <button type="button" className="advice-toggle" onClick={toggle} aria-expanded={open}>
        <span className="advice-eyebrow">Suggested</span>
        <PlayerFace id={p.id} pos={p.pos} team={p.team} size={22} />
        <span className="advice-line">
          <PosTag pos={p.pos} /> <strong>{p.name}</strong>
          {nextOverall && (
            <span className="ac-meta"> · {pct(take.survival)}% to last</span>
          )}
        </span>
        <span className="advice-chev" aria-hidden="true">
          {open ? '⌃' : '⌄'}
        </span>
      </button>

      {!open && (
        <span className="sr-only">Open for why, and for what you can safely leave.</span>
      )}

      {open && (
      <div className="advice-body">
      <div className="advice-head">
        <span className="stat-label">
          {starterComplete
            ? 'Your starters are set — best left on the board'
            : `Take a ${noun(take.pos)}`}
        </span>
        {nextOverall && take.tierSize > 0 && (
          <span className="ac-meta">
            {take.likelyLeft === 0
              ? `none of the top ${take.tierSize} last to #${nextOverall}`
              : `${take.likelyLeft} of the top ${take.tierSize} last to #${nextOverall}`}
          </span>
        )}
      </div>

      <div className="advice-pick">
        <div className="advice-name">
          <strong>{p.name}</strong>{' '}
          <span className="ac-meta">
            <PosTag pos={p.pos} /> · {p.team}
          </span>
          {p.injury && (
            <>
              {' '}
              <InjuryFlag status={p.injury} />
            </>
          )}
        </div>
        <p className="advice-why">{because(take, nextOverall)}</p>
        <button
          type="button"
          className="btn-ghost advice-take"
          onClick={() => onDraft(p.id)}
        >
          Draft {p.name} →
        </button>
      </div>

      {alternatives.length > 0 && (
        <>
          <div className="stat-label advice-sub">Also defensible</div>
          <ul className="advice-list">
            {alternatives.map((c) => (
              <Row key={c.pos} c={c} nextOverall={nextOverall} />
            ))}
          </ul>
        </>
      )}

      {/* Knowing what you can safely leave is half of drafting well, and it is
          the half nobody ever tells a beginner. */}
      {canWait.length > 0 && nextOverall && (
        <p className="advice-wait">
          You can leave{' '}
          {canWait.map((c, i) => (
            <span key={c.pos}>
              {i > 0 ? (i === canWait.length - 1 ? ' and ' : ', ') : ''}
              <strong>{noun(c.pos)}</strong> ({pct(c.survival)}% {c.best.player.name.split(' ').slice(-1)[0]} lasts)
            </span>
          ))}{' '}
          — those should still be there at #{nextOverall}.
        </p>
      )}
      </div>
      )}
    </div>
  )
}
