import type { AdpEntry } from './adp.ts'
import type { FantasyPos } from './players.ts'
import { rosterNeeds } from './draft.ts'
import { survivalOdds } from './mock.ts'

/**
 * Who to take with this pick, and why.
 *
 * ---------------------------------------------------------------------------
 * THE MODEL: what does waiting cost you?
 *
 * "Best available" is a list, not advice — it ignores that you already have
 * three receivers and no tight end. "Biggest need" is worse: it takes a bad
 * tight end in round two because the slot is empty. Both are what every other
 * draft tool does, and both are avoidable here because we have a number almost
 * nobody has: the odds a given player is still on the board at your NEXT turn.
 *
 * So instead of scoring players, this scores POSITIONS by what it costs to wait
 * on them:
 *
 *     cost = P(the best one is gone by your next pick)
 *            × (how much worse your fallback would be)
 *
 * Both halves are derived, not invented. The first is `survivalOdds`, a normal
 * CDF over that player's own observed ADP spread. The second is the gap in
 * board position between the best player at that position and the best one who
 * will probably still be there next turn — the tier break, measured rather
 * than eyeballed.
 *
 * The result behaves correctly at both ends of a draft without special-casing.
 * In round one every slot is empty, so need does not discriminate and the model
 * reduces to "take the position where the drop-off is steepest", which is what
 * a good drafter does. By round ten most slots are full, need dominates, and it
 * starts telling you to fill the hole. Nothing switches over; the same
 * arithmetic just changes its mind as the board does.
 *
 * The units are picks of board position throughout, so every number in the
 * output can be checked against the board by hand. That is the point: a
 * recommendation you cannot audit is indistinguishable from a guess.
 * ---------------------------------------------------------------------------
 */

/** Positions whose draft timing is convention, not market. See lib/analysis.ts. */
const BY_CONVENTION: FantasyPos[] = ['K', 'DEF']

const FLEX_ELIGIBLE: FantasyPos[] = ['RB', 'WR', 'TE']

/**
 * Above this, a player is "probably still there", so he is the fallback you'd
 * be settling for. Deliberately generous: a fallback you only get 55% of the
 * time is not a fallback, and overstating it would understate every drop-off.
 */
const LIKELY = 0.6

/**
 * Scarcity is reported against the top of the position, not the whole of it.
 *
 * "How many receivers are left" has no natural quality cutoff, so every honest
 * answer to it is useless: counting the market says 75 receivers survive to
 * your next pick, on a panel correctly telling you that the one you want is 0%
 * to. It counts ADP-180 receivers as if they were replacements for an ADP-8
 * one. Ten is a display window, stated plainly in the copy as "of the top 10"
 * rather than hidden inside a score — the reader can see exactly what was
 * counted.
 */
const TIER_WINDOW = 10

export interface PositionCase {
  pos: FantasyPos
  /** Best available here. */
  best: AdpEntry
  /** Odds `best` survives to your next turn. */
  survival: number
  /** Best one you'd probably still get next turn, if there is one. */
  fallback: AdpEntry | null
  /** Board positions between `best` and `fallback`. The tier break. */
  dropoff: number
  /** P(gone) × dropoff, in picks of board position. */
  cost: number
  /** Does this fill a starting slot you have not filled? */
  fillsStarter: boolean
  /**
   * How many at this position should still be on the board at your next turn.
   *
   * Counted among the best `TIER_WINDOW` still available at the position, not
   * the whole board — see the note on TIER_WINDOW for why every wider answer is
   * simultaneously true and useless.
   */
  likelyLeft: number
  /** What `likelyLeft` was counted out of, so the copy can say so. */
  tierSize: number
}

export interface Advice {
  /** The recommendation. Null when there is nothing sensible to take. */
  take: PositionCase | null
  /** Runners-up, most costly to wait on first. */
  alternatives: PositionCase[]
  /** Positions where the top man will probably still be there — leave them. */
  canWait: PositionCase[]
  /** True once every starting slot is filled and this is bench shopping. */
  starterComplete: boolean
}

export function suggestPicks(opts: {
  entries: AdpEntry[]
  taken: Set<string>
  myPlayers: { pos: FantasyPos }[]
  slots: Record<string, number>
  currentOverall: number
  /** Your next turn, or null if this is your last pick. */
  nextOverall: number | null
  round: number
  totalRounds: number
}): Advice {
  const { entries, taken, myPlayers, slots, currentOverall, nextOverall, round, totalRounds } = opts

  const needs = rosterNeeds(slots, myPlayers)
  const unfilled = new Set(needs.filter((s) => s.filled < s.need).map((s) => s.slot))
  const flexOpen = unfilled.has('FLEX')
  const starterComplete = unfilled.size === 0

  // Same rule the board and the opponents use: nobody spends a real pick on a
  // kicker until the end, so suggesting one in round six would be advice that
  // costs someone a startable player.
  const allowLate = round > totalRounds - 2

  // Board position is the unit. Index in an ADP-sorted board is the consensus
  // rank, which is comparable to a pick number; raw ADP is not, because it is
  // measured in 12-team drafts. See the note in lib/analysis.ts.
  const rankOf = new Map(entries.map((e, i) => [e.player.id, i + 1]))

  const byPos = new Map<FantasyPos, AdpEntry[]>()
  for (const e of entries) {
    if (taken.has(e.player.id)) continue
    const pos = e.player.pos
    if (BY_CONVENTION.includes(pos) && !allowLate) continue
    const list = byPos.get(pos)
    if (list) list.push(e)
    else byPos.set(pos, [e])
  }

  const cases: PositionCase[] = []

  for (const [pos, list] of byPos) {
    const best = list[0]
    if (!best) continue

    const fillsStarter =
      unfilled.has(pos) || (flexOpen && FLEX_ELIGIBLE.includes(pos))

    /**
     * Only positions you can actually start are worth reasoning about.
     *
     * Once every slot is full this is bench shopping, and then the honest
     * answer is "take the best player left", so everything stays in play.
     */
    if (!starterComplete && !fillsStarter) continue

    const survival = nextOverall ? survivalOdds(best, currentOverall, nextOverall) : 0

    /**
     * Everything below reasons over the OBSERVED market only.
     *
     * Past it the board is Sleeper's rank order wearing a synthetic ADP and a
     * deliberately wide spread, so those players never come off the board in
     * the model and would make every position look bottomless.
     */
    const market = list.filter((e) => e.observed)

    // Your realistic consolation prize: the best one here you'd probably still
    // get next turn.
    const fallback =
      nextOverall
        ? market.find(
            (e) => e.player.id !== best.player.id &&
              survivalOdds(e, currentOverall, nextOverall) >= LIKELY,
          ) ?? null
        : null

    const bestRank = rankOf.get(best.player.id) ?? 0
    const fallbackRank = fallback ? rankOf.get(fallback.player.id) ?? 0 : 0
    /**
     * No likely fallback means the cupboard is bare behind him — but only as far
     * as the market can see. The gap to the last player the market still has is
     * real and conservative; the distance to the end of a 600-deep board would
     * be an invented number.
     */
    const tier = market.slice(0, TIER_WINDOW)
    const lastInMarket = market.length > 0 ? market[market.length - 1] : null
    const dropoff = fallback
      ? Math.max(0, fallbackRank - bestRank)
      : lastInMarket
        ? Math.max(0, (rankOf.get(lastInMarket.player.id) ?? bestRank) - bestRank)
        // The market is exhausted here. This is bench filler, and there is
        // nothing left to be urgent about.
        : 0

    cases.push({
      pos,
      best,
      survival,
      fallback,
      dropoff,
      cost: (1 - survival) * dropoff,
      fillsStarter,
      likelyLeft: nextOverall
        ? tier.filter((e) => survivalOdds(e, currentOverall, nextOverall) >= LIKELY).length
        : 0,
      tierSize: tier.length,
    })
  }

  // Most expensive to wait on, first. Board order breaks ties so two positions
  // with identical cost don't swap places between renders.
  cases.sort(
    (a, b) =>
      b.cost - a.cost ||
      (rankOf.get(a.best.player.id) ?? 0) - (rankOf.get(b.best.player.id) ?? 0),
  )

  const take = cases[0] ?? null
  return {
    take,
    alternatives: cases.slice(1, 3),
    // Worth saying out loud: knowing what you can safely leave is half of
    // drafting well, and it is the half nobody tells you.
    canWait: cases.filter((c) => c !== take && c.survival >= LIKELY).slice(0, 3),
    starterComplete,
  }
}
