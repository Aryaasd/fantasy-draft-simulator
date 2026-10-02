import type { AdpBoard, AdpEntry, MarketPlayer } from './adp.ts'
import type { FantasyPos } from './players.ts'
import { assignLineup, type LineupEntry } from './lineup.ts'
import { nextPickForMe, roundAndPick, rosterNeeds, slotForOverall, unfilledSlots } from './draft.ts'

/**
 * What the draft you just ran actually produced.
 *
 * Reads a finished pick list, so it does not care whether that list came from
 * the built-in simulator or from a parsed Yahoo screenshot. One engine, three
 * inputs — a rehearsal, a Yahoo mock, and the real draft on September 4.
 *
 * ---------------------------------------------------------------------------
 * WHY THE GRADE IS WHAT IT IS
 *
 * Three metrics were measured against real ADP across twelve full 18-team
 * drafts before this file was written. Two of them are wrong, and both are the
 * obvious thing to reach for:
 *
 *  1. SUM OF (adp - overall) — "value captured". Every team scores about -300,
 *     because ADP only covers ~190 picks and an 18-team draft runs to 270. Past
 *     the market every pick is negative by construction, so the number measures
 *     league depth, not drafting. Shown to a member as "value captured: -313"
 *     it reads as a failure when it is arithmetic.
 *
 *  2. REACH vs BEST AVAILABLE — pleasingly slot-neutral (spread 3.4 across all
 *     eighteen slots, against a within-slot noise of 2.6), and completely wrong
 *     as a grade: a drafter who always takes the top of the board scores a
 *     perfect zero. That is precisely the strategy that finished a test draft
 *     with two defenses, no tight end and no kicker. A grade that hands an A+
 *     to the worst possible strategy is worse than no grade.
 *
 *  3. STARTER STRENGTH — rank each team's actual STARTERS, slot by slot,
 *     against the same slot on all the other teams, then rank the teams by
 *     their average. This is what ships. It uses ADP the one way ADP is
 *     defensible — as the market's opinion of who is better — and it grades the
 *     team you built rather than the prices you paid.
 *
 * Even (3) needs a guard. Measured, the greedy top-of-board drafter still
 * finished 3rd of 18 with THREE empty starting slots, because six strong
 * starters outweighed three terrible ones in the average. So an incomplete
 * lineup CAPS the grade outright. That is a rule, not a weight — an empty
 * starting slot is a zero in that position every single week, and no amount of
 * strength elsewhere makes it not one.
 *
 * Slot bias is left uncorrected: early slots finish about 3.8 places higher out
 * of 18. That is a real property of snake drafts, not an artifact, and
 * handicapping it would be inventing a number.
 *
 * ---------------------------------------------------------------------------
 * WHY PICK VALUE IS MEASURED IN BOARD POSITION, NOT ADP
 *
 * `lib/adp.ts` fetches ADP with teams=12, and says so: the ordering is
 * identical across league sizes, so we take the ordering. The NUMBER is not
 * identical — it is a 12-team pick number, so it tops out near 180 while an
 * 18-team draft runs to 270. Subtracting one from the other compares different
 * units, and every pick after ~180 shows a slide that is pure arithmetic.
 *
 * It is not subtle in practice. It reported a defense taken at #248 with an ADP
 * of 133 as having "slid 115 picks to you" — the single best value of the
 * draft, when what actually happened is that nobody drafts a defense early.
 *
 * So value is measured in BOARD POSITION: the board is ADP-sorted, so a
 * player's index is the consensus rank, and in a draft that followed consensus
 * exactly the player at index i goes at pick i+1 whatever the league size.
 * That is unit-consistent against `overall`.
 *
 * A second limit, found the same way: consensus position past the END of the
 * draft is not a reach either. A 12-team, 15-round league is 180 picks, so a
 * player whose consensus position is 217 is not "96 picks early" — the market
 * simply does not draft him at this league size. Left uncapped, the biggest
 * reach of a real card came out as a round-12 backup quarterback, burying the
 * round-4 reach that actually cost a starter. Those picks are reported as
 * typically-undrafted instead, which is both true and more useful.
 *
 * Kickers and defenses are excluded from value and from passed-on entirely.
 * Their draft position is set by convention — nobody spends a real pick on one
 * until the end, and `simulateAdpPick` enforces exactly that — so their ADP
 * says nothing about when they were "supposed" to go. Left in, every K and DEF
 * in a deep league reads as a steal, and the best available late in the draft
 * is always a defense.
 * ---------------------------------------------------------------------------
 */

/** Positions whose draft timing is convention, not market. */
const BY_CONVENTION: FantasyPos[] = ['K', 'DEF']

/** An empty starting slot sorts below every real player, however bad. */
const NO_STARTER = Number.MAX_SAFE_INTEGER

/** Any unfilled starting slot holds the grade here, whatever else is true. */
const HOLE_CAP = 'C'

const LADDER = ['D', 'C-', 'C', 'C+', 'B-', 'B', 'B+', 'A-', 'A', 'A+']

export interface StarterSlot {
  label: string
  slot: string
  player: MarketPlayer | null
  adp: number | null
  round: number | null
  /** 1 = best in the league at this lineup slot. */
  rank: number
}

export interface PickValue {
  player: MarketPlayer
  overall: number
  round: number
  /** The pick he'd have gone at if the draft followed consensus exactly. */
  adp: number
  /**
   * Where the board says he should have gone — his consensus position, not his
   * raw ADP. See the note at the top on why those are different numbers.
   */
  slide: number
}

export interface PassedOn {
  player: MarketPlayer
  /** Your pick where you passed on him. */
  atOverall: number
  atRound: number
  tookInstead: MarketPlayer
  /** Your following turn, or null if that was your last pick. */
  nextOverall: number | null
  /** Was he still on the board when you picked again? */
  survived: boolean
  /** Where he actually went, or null if nobody took him. */
  wentAt: number | null
  /**
   * How far apart the market had these two, in ADP positions. A gap of 2 is
   * the market shrugging; a gap of 40 is it disagreeing with you loudly. Lets
   * the report drop the ones not worth mentioning.
   */
  gap: number
}

export interface PositionRank {
  pos: FantasyPos
  count: number
  /** 1 = deepest in the league at this position. */
  rank: number
}

export interface DraftReport {
  teams: number
  slot: number
  grade: string
  /** 1 = strongest starting lineup in the league. */
  rankOfField: number
  /**
   * Set only when an incomplete lineup actually lowered the grade, naming the
   * slots. Holes that didn't change the outcome are still in `unfilled`.
   */
  cappedBy: string[] | null
  starters: StarterSlot[]
  steal: PickValue | null
  reach: PickValue | null
  /**
   * Players the market doesn't draft at this league size at all. Not reaches —
   * consensus has no opinion on WHEN they go, only that they don't go.
   */
  typicallyUndrafted: MarketPlayer[]
  passedOn: PassedOn[]
  depth: PositionRank[]
  unfilled: string[]
}

export interface Pick {
  playerId: string
  overall: number
}

/**
 * Can this pick's value be talked about at all?
 *
 * Needs a player the market actually drafted — past the observed board the ADP
 * is a synthetic counter, so "he slid to you" would be a claim about an array
 * index — and a position whose timing the market, rather than convention,
 * decides.
 */
function gradeable(entry: AdpEntry | undefined): boolean {
  return !!entry && entry.observed && !BY_CONVENTION.includes(entry.player.pos)
}

/**
 * Is this player inside the range a league this size actually drafts?
 *
 * Past the final pick the market has no opinion about WHEN he goes, only that
 * he doesn't. Differencing against that produces a number with no meaning.
 */
function withinDraft(expected: number, teams: number, rounds: number): boolean {
  return expected <= teams * rounds
}

function toEntries(
  picks: Pick[],
  teams: number,
  slot: number,
  byId: Map<string, AdpEntry>,
): LineupEntry<MarketPlayer>[] {
  return picks
    .filter((p) => slotForOverall(p.overall, teams) === slot)
    .map((p): LineupEntry<MarketPlayer> | null => {
      const e = byId.get(p.playerId)
      return e
        ? { player: e.player, round: roundAndPick(p.overall, teams).round, order: e.adp }
        : null
    })
    .filter((e): e is LineupEntry<MarketPlayer> => !!e)
}

export function analyzeDraft(opts: {
  picks: Pick[]
  board: AdpBoard
  teams: number
  slot: number
  rounds: number
  slots: Record<string, number>
}): DraftReport {
  const { picks, board, teams, slot, rounds, slots } = opts
  const byId = new Map(board.entries.map((e) => [e.player.id, e]))
  /**
   * Consensus rank -> the pick a player would go at if the draft followed the
   * board exactly. Unit-consistent with `overall`, unlike ADP itself.
   */
  const expectedAt = new Map(board.entries.map((e, i) => [e.player.id, i + 1]))

  // --- every team's starters, so mine can be ranked against them ------------

  const lineups = Array.from({ length: teams }, (_, i) =>
    assignLineup(toEntries(picks, teams, i + 1, byId), slots),
  )

  const adpOf = (p: MarketPlayer | null | undefined) =>
    p ? (byId.get(p.id)?.adp ?? NO_STARTER) : NO_STARTER

  const slotCount = lineups[slot - 1]?.starters.length ?? 0
  const rankSum = new Array<number>(teams).fill(0)

  for (let s = 0; s < slotCount; s++) {
    const order = lineups
      .map((l, team) => ({ team, adp: adpOf(l.starters[s]?.entry?.player) }))
      // Ties are broken by team index so the ordering is stable across renders.
      .sort((a, b) => a.adp - b.adp || a.team - b.team)
    order.forEach((o, i) => {
      rankSum[o.team] += i + 1
    })
  }

  const avgRank = rankSum.map((sum) => (slotCount > 0 ? sum / slotCount : 0))
  const standings = avgRank
    .map((v, team) => ({ team, v }))
    .sort((a, b) => a.v - b.v || a.team - b.team)
  const rankOfField = standings.findIndex((s) => s.team === slot - 1) + 1

  // --- my lineup, with each slot's standing --------------------------------

  const mine = lineups[slot - 1] ?? { starters: [], bench: [] }
  const starters: StarterSlot[] = mine.starters.map((s, i) => {
    const adp = adpOf(s.entry?.player)
    const better = lineups.filter(
      (l, team) =>
        team !== slot - 1 &&
        (adpOf(l.starters[i]?.entry?.player) < adp ||
          (adpOf(l.starters[i]?.entry?.player) === adp && team < slot - 1)),
    ).length
    return {
      label: s.label,
      slot: s.slot,
      player: s.entry?.player ?? null,
      adp: s.entry ? adp : null,
      round: s.entry?.round ?? null,
      rank: better + 1,
    }
  })

  // --- positional depth against the field ----------------------------------

  const countsFor = (team: number) => {
    const c = new Map<FantasyPos, number>()
    for (const p of picks) {
      if (slotForOverall(p.overall, teams) !== team) continue
      const pos = byId.get(p.playerId)?.player.pos
      if (pos) c.set(pos, (c.get(pos) ?? 0) + 1)
    }
    return c
  }
  const allCounts = Array.from({ length: teams }, (_, i) => countsFor(i + 1))
  const myCounts = allCounts[slot - 1]

  const depth: PositionRank[] = (['QB', 'RB', 'WR', 'TE', 'K', 'DEF'] as FantasyPos[])
    .map((pos) => {
      const count = myCounts.get(pos) ?? 0
      const better = allCounts.filter((c, i) => i !== slot - 1 && (c.get(pos) ?? 0) > count).length
      return { pos, count, rank: better + 1 }
    })

  // --- individual picks: what slid, what you reached for -------------------

  const myPicks = picks.filter((p) => slotForOverall(p.overall, teams) === slot)

  let steal: PickValue | null = null
  let reach: PickValue | null = null
  /** Picks the market doesn't rate as draftable at this league size. */
  const undrafted: MarketPlayer[] = []

  for (const p of myPicks) {
    const e = byId.get(p.playerId)
    if (!gradeable(e)) continue
    const expected = expectedAt.get(p.playerId)!
    if (!withinDraft(expected, teams, rounds)) {
      undrafted.push(e!.player)
      continue
    }
    const v: PickValue = {
      player: e!.player,
      overall: p.overall,
      round: roundAndPick(p.overall, teams).round,
      adp: expected,
      slide: p.overall - expected,
    }
    if (!steal || v.slide > steal.slide) steal = v
    if (!reach || v.slide < reach.slide) reach = v
  }
  // A pick can't be both, and a draft where nobody slid has no steal to report.
  if (steal && steal.slide <= 0) steal = null
  if (reach && reach.slide >= 0) reach = null
  if (steal && reach && steal.overall === reach.overall) reach = null

  // --- who you passed on, and whether waiting would have worked ------------

  const wentAt = new Map<string, number>()
  for (const p of picks) wentAt.set(p.playerId, p.overall)

  const passedOn: PassedOn[] = []
  for (const p of myPicks) {
    const took = byId.get(p.playerId)
    // Spending a late pick on a kicker isn't passing on anybody — that pick was
    // always going to be a kicker.
    if (!took || BY_CONVENTION.includes(took.player.pos)) continue

    // The board as it stood when you were on the clock.
    const goneByNow = new Set(picks.filter((x) => x.overall < p.overall).map((x) => x.playerId))
    const best = board.entries.find(
      (e) =>
        !goneByNow.has(e.player.id) &&
        e.player.id !== p.playerId &&
        !BY_CONVENTION.includes(e.player.pos),
    )
    if (!best) continue
    // Taking the top of the board isn't passing on anyone.
    if (best.adp >= took.adp) continue

    const next = nextPickForMe(p.overall + 1, slot, teams, rounds)
    const went = wentAt.get(best.player.id) ?? null
    passedOn.push({
      player: best.player,
      atOverall: p.overall,
      atRound: roundAndPick(p.overall, teams).round,
      tookInstead: took.player,
      nextOverall: next?.overall ?? null,
      /**
       * Still on the board when your next turn came round.
       *
       * `>=`, not `>`. A player taken AT your next pick was available when that
       * pick was made — and since that pick is yours, going at exactly that
       * number means you circled back and took him. Scoring that as "gone"
       * called the one case where waiting demonstrably worked a failure.
       */
      survived: next ? went === null || went >= next.overall : false,
      wentAt: went,
      gap: took.adp - best.adp,
    })
  }

  // Biggest gaps first: the picks where the market most disagreed with you.
  passedOn.sort((a, b) => b.gap - a.gap || a.atOverall - b.atOverall)

  // --- grade ---------------------------------------------------------------

  const unfilled = unfilledSlots(
    rosterNeeds(slots, toEntries(picks, teams, slot, byId).map((e) => e.player)),
  )

  /**
   * The cap only binds when it actually lowers the grade.
   *
   * Reporting "held at D because you finished without a tight end" to a team
   * that finished 18th of 18 on its own merits claims a causation that isn't
   * there — the holes didn't hold that grade down, the roster did.
   */
  const natural = curve(rankOfField, teams)
  const capBinds =
    unfilled.length > 0 && LADDER.indexOf(natural) > LADDER.indexOf(HOLE_CAP)
  const grade = capBinds ? HOLE_CAP : natural

  return {
    teams,
    slot,
    grade,
    rankOfField,
    cappedBy: capBinds ? unfilled : null,
    starters,
    steal,
    reach,
    typicallyUndrafted: undrafted,
    passedOn,
    depth,
    unfilled,
  }
}

/**
 * Rank to letter, curved across the field.
 *
 * Floors at D rather than running to F. The register this product is built in
 * says never make someone feel stupid, and an F on a rehearsal is exactly the
 * experience it exists as an alternative to. "D — 17th of 18" is honest without
 * being cruel, and the rank underneath is the real finding anyway.
 */
export function curve(rank: number, teams: number): string {
  if (teams <= 1) return 'A'
  const p = (teams - rank) / (teams - 1)
  if (p >= 0.95) return 'A+'
  if (p >= 0.85) return 'A'
  if (p >= 0.72) return 'A-'
  if (p >= 0.6) return 'B+'
  if (p >= 0.45) return 'B'
  if (p >= 0.33) return 'B-'
  if (p >= 0.22) return 'C+'
  if (p >= 0.12) return 'C'
  if (p >= 0.05) return 'C-'
  return 'D'
}
