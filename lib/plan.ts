import type { AdpBoard, MarketPlayer } from './adp.ts'
import type { FantasyPos } from './players.ts'
import { availabilityAt } from './mock.ts'
import { overallForRound, rosterNeeds } from './draft.ts'

/**
 * A draft plan you can take into the room.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM THE MOCK DRAFT
 *
 * The mock is interactive and answers "what happens if I do this?". With a
 * 30-second clock nobody is exploring branches — they want a sheet that says
 * "at pick 25, realistically these five are there, and this is the one you
 * need". That is a different artefact: static, scannable, and made before the
 * draft rather than during it.
 *
 * Availability is the analytic prior from `availabilityAt`, not a simulation.
 * Running two hundred mock drafts would be more faithful to how runs and
 * position scarcity interact, but it costs ~36,000 simulated picks and returns
 * a noisier answer to a question that is already approximate. The smooth curve
 * is the honest shape of "how often is someone like this still there".
 *
 * Every number is a PRIOR, not a promise. A plan that says 82% is saying it
 * will be wrong about one pick in five, and the copy has to carry that.
 * ---------------------------------------------------------------------------
 */

/** Comfortable: you can build a plan around him being there. */
const LIKELY = 0.75

/** A real chance, worth knowing about, not worth planning on. */
const STRETCH = 0.4

const FLEX_ELIGIBLE: FantasyPos[] = ['RB', 'WR', 'TE']

export interface PlanCandidate {
  player: MarketPlayer
  /** P(still on the board when this pick comes round). */
  availability: number
  /** Consensus position — where the market has him going. */
  consensus: number
  /** Does he fill a slot still open at this point in the plan? */
  fillsNeed: boolean
}

export interface PlanPick {
  overall: number
  round: number
  /** The pick the plan assumes you make. Drives what is still needed later. */
  take: PlanCandidate | null
  /** Others comfortably likely to be there. */
  likely: PlanCandidate[]
  /** Might fall to you. Worth recognising, not worth planning on. */
  stretch: PlanCandidate[]
  /** Slots still unfilled going INTO this pick. */
  stillNeeded: string[]
}

export function draftPlan(opts: {
  board: AdpBoard
  slot: number
  teams: number
  rounds: number
  slots: Record<string, number>
  /** How many alternatives to carry per pick. */
  width?: number
}): PlanPick[] {
  const { board, slot, teams, rounds, slots, width = 4 } = opts
  const rankOf = new Map(board.entries.map((e, i) => [e.player.id, i + 1]))

  /**
   * Walked forward, taking the plan's own pick each round.
   *
   * Needs have to evolve or every round recommends a running back. Committing
   * to the pick is what makes the sheet a plan rather than six separate
   * best-available lists.
   */
  const planned: MarketPlayer[] = []
  const spoken = new Set<string>()
  const out: PlanPick[] = []

  for (let round = 1; round <= rounds; round++) {
    const overall = overallForRound(round, slot, teams)

    const needs = rosterNeeds(slots, planned)
    const open = new Set(needs.filter((s) => s.filled < s.need).map((s) => s.slot))
    const flexOpen = open.has('FLEX')
    const stillNeeded = needs.filter((s) => s.filled < s.need).map((s) => s.slot)

    // Nobody spends a real pick on a kicker or defense before the end, and a
    // plan that says otherwise would cost someone a startable player.
    const allowLate = round > rounds - 2

    const pool: PlanCandidate[] = []
    for (const e of board.entries) {
      if (spoken.has(e.player.id)) continue
      const pos = e.player.pos
      if (!allowLate && (pos === 'K' || pos === 'DEF')) continue
      // Past the observed market the ADP is a synthetic counter, so an
      // availability computed from it would be arithmetic on an array index.
      if (!e.observed) continue

      const availability = availabilityAt(e, overall)
      if (availability < STRETCH) continue

      pool.push({
        player: e.player,
        availability,
        consensus: rankOf.get(e.player.id) ?? 0,
        fillsNeed: open.has(pos) || (flexOpen && FLEX_ELIGIBLE.includes(pos)),
      })
      // The board is consensus-sorted, so once we are deep enough to have a
      // full slate of realistic names the rest are worse on every axis.
      if (pool.length >= 60) break
    }

    // The plan's own pick: the best player who fills something you still need
    // AND is comfortably likely to be there. Planning around a coin flip is not
    // planning.
    const take =
      pool.find((c) => c.fillsNeed && c.availability >= LIKELY) ??
      pool.find((c) => c.availability >= LIKELY) ??
      pool[0] ??
      null

    if (take) {
      planned.push(take.player)
      spoken.add(take.player.id)
    }

    out.push({
      overall,
      round,
      take,
      likely: pool
        .filter((c) => c !== take && c.availability >= LIKELY)
        .slice(0, width),
      stretch: pool
        .filter((c) => c !== take && c.availability < LIKELY && c.fillsNeed)
        .slice(0, width),
      stillNeeded,
    })
  }

  return out
}
