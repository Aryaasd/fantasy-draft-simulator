import type { FantasyPos } from './players.ts'
import { rosterNeeds, slotForOverall, unfilledSlots } from './draft.ts'

/**
 * "The room" — what every other team in the draft is actually building.
 *
 * The guide tells people to do this by hand ("Note who is stacking a position.
 * That is your trade partner in three weeks." — lib/basics.ts, read-the-room),
 * and then no surface in the app shows it. The data has always been there:
 * picks are logged in order, so `slotForOverall` assigns every one of them to
 * a team for free. This just reads it back.
 *
 * Deliberately NOT a draft-results grid. A grid is a record — 270 cells you
 * consult once. What makes the advice actionable is each team's SHAPE: who is
 * deep, who has a hole, and therefore who wants what you have.
 *
 * Equally deliberately, nothing here values a player. Structural fit is
 * derivable from the board with certainty; what a player is WORTH needs
 * current-season data, and a number invented here would be exactly the
 * confident-wrong answer the grounding contract in lib/prompt.ts exists to
 * prevent. The room states the structure and leaves valuation to Lacey, who
 * searches. Same split as the static guide vs. the live ask.
 */

const POSITIONS: FantasyPos[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']

/** FLEX takes any of these, so spare depth at one is not really spare. */
const FLEX_ELIGIBLE: FantasyPos[] = ['RB', 'WR', 'TE']

/** The least we need to know about a drafted player. */
export interface RoomPlayer {
  id: string
  name: string
  pos: FantasyPos
}

export interface TeamShape {
  slot: number
  label: string
  isMe: boolean
  players: RoomPlayer[]
  counts: Partial<Record<FantasyPos, number>>
  /** Unfilled slot names, FLEX included — for display. */
  unfilled: string[]
  /** Positions held beyond every starting slot they could fill. */
  surplus: FantasyPos[]
  /** Positions whose own starting slot is still empty. */
  holes: FantasyPos[]
}

export interface TradeFit {
  slot: number
  label: string
  /** My surplus that fills a hole of theirs. */
  theyWant: FantasyPos[]
  /** Their surplus that fills a hole of mine. */
  iWant: FantasyPos[]
  score: number
}

/**
 * Positions a team holds beyond anything they could start.
 *
 * Spare RB/WR/TE is not surplus while the FLEX is empty — that is a starter,
 * not a trade chip. Flex capacity is consumed from the deepest pool first,
 * which is what a real drafter does with their best spare, with a name
 * tiebreak so the result is stable across renders.
 */
function surplusOf(
  counts: Partial<Record<FantasyPos, number>>,
  slots: Record<string, number>,
): FantasyPos[] {
  const spare: Partial<Record<FantasyPos, number>> = {}
  for (const pos of POSITIONS) {
    spare[pos] = Math.max(0, (counts[pos] ?? 0) - (slots[pos] ?? 0))
  }

  let flexLeft = slots.FLEX ?? 0
  const deepestFirst = FLEX_ELIGIBLE.filter((p) => (spare[p] ?? 0) > 0).sort(
    (a, b) => (spare[b] ?? 0) - (spare[a] ?? 0) || a.localeCompare(b),
  )
  for (const pos of deepestFirst) {
    if (flexLeft <= 0) break
    const used = Math.min(spare[pos] ?? 0, flexLeft)
    spare[pos] = (spare[pos] ?? 0) - used
    flexLeft -= used
  }

  return POSITIONS.filter((p) => (spare[p] ?? 0) > 0)
}

/**
 * Every team's roster and shape, derived from the picks logged so far.
 *
 * `lookup` is injected rather than imported because the mock holds
 * `Map<id, AdpEntry>` and the draft board holds `Map<id, PoolPlayer>`. Taking
 * a resolver keeps this module ignorant of both — the same reason
 * `rosterNeeds` accepts `{pos}[]` and `fetchAdpBoard` takes the pool as an
 * argument.
 */
export function readTheRoom(opts: {
  picks: { playerId: string; overall: number }[]
  teams: number
  slots: Record<string, number>
  lookup: (id: string) => RoomPlayer | undefined
  /** slot -> member name. Absent in a mock, where opponents are simulated. */
  labels?: Map<number, string>
  mySlot?: number
}): TeamShape[] {
  const { picks, teams, slots, lookup, labels, mySlot } = opts

  // A league needs at least one team. Anything else (0, negative, fractional,
  // NaN from a corrupted setting) has no room to describe, and pressing on
  // would divide by it.
  if (!Number.isInteger(teams) || teams < 1) return []

  const byTeam = new Map<number, RoomPlayer[]>()
  for (let s = 1; s <= teams; s++) byTeam.set(s, [])

  // The board is rehydrated from localStorage, which anyone can edit and any
  // half-finished write can corrupt, so nothing below trusts a pick's shape.
  const seen = new Set<string>()

  for (const pick of picks) {
    // Overall picks are 1-based integers. A negative or fractional one still
    // resolves to a slot through the snake maths — it just resolves to the
    // WRONG one, silently handing somebody a player they never drafted.
    if (!Number.isInteger(pick.overall) || pick.overall < 1) continue

    // One player, one roster. A duplicated id would otherwise be counted on
    // two teams at once, inflating both their surplus and turning a phantom
    // into a trade recommendation. First occurrence wins, which is draft order.
    if (seen.has(pick.playerId)) continue

    const owner = slotForOverall(pick.overall, teams)
    const roster = byTeam.get(owner)
    if (!roster) continue

    // A pick whose player can't be resolved is dropped rather than faked. The
    // pool crosses a network boundary; one missing row shouldn't invent a
    // roster hole that isn't there.
    const player = lookup(pick.playerId)
    if (!player) continue

    seen.add(pick.playerId)
    roster.push(player)
  }

  const out: TeamShape[] = []
  for (let slot = 1; slot <= teams; slot++) {
    const players = byTeam.get(slot) ?? []

    const counts: Partial<Record<FantasyPos, number>> = {}
    for (const p of players) counts[p.pos] = (counts[p.pos] ?? 0) + 1

    const needs = rosterNeeds(slots, players)

    out.push({
      slot,
      label: labels?.get(slot) ?? `Team ${slot}`,
      isMe: slot === mySlot,
      players,
      counts,
      unfilled: unfilledSlots(needs),
      surplus: surplusOf(counts, slots),
      holes: needs
        .filter((s) => s.slot !== 'FLEX' && s.filled < s.need)
        .map((s) => s.slot as FantasyPos)
        .filter((p) => POSITIONS.includes(p)),
    })
  }

  return out
}

/**
 * Who to call, best first.
 *
 * Ranking by fit rather than by slot number is the whole feature. Sorted 1..N
 * you have to scan eighteen rosters and do the comparison yourself, which is
 * the work people already don't do; sorted by fit, the answer is the first
 * row.
 *
 * A two-way match scores above two one-way matches: "they have what I need AND
 * need what I have" is a trade that can actually be proposed, while a one-way
 * fit is just a wish. Every team is returned, including scoreless ones, so the
 * caller can still show the full room — ordering carries the signal, not
 * omission.
 */
export function tradeFits(room: TeamShape[], mySlot: number): TradeFit[] {
  const me = room.find((t) => t.slot === mySlot)
  if (!me) return []

  const fits: TradeFit[] = []
  for (const them of room) {
    if (them.slot === mySlot) continue
    const theyWant = me.surplus.filter((p) => them.holes.includes(p))
    const iWant = them.surplus.filter((p) => me.holes.includes(p))
    const twoWay = theyWant.length > 0 && iWant.length > 0 ? 2 : 0
    fits.push({
      slot: them.slot,
      label: them.label,
      theyWant,
      iWant,
      score: theyWant.length + iWant.length + twoWay,
    })
  }

  fits.sort((a, b) => b.score - a.score || a.slot - b.slot)
  return fits
}
