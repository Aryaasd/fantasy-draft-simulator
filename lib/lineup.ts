import type { FantasyPos } from './players.ts'
import { orderSlots } from './draft.ts'

/**
 * A drafted roster arranged as a starting lineup.
 *
 * The roster panels used to be a draft log — `R1 Bijan · R2 Smith · R3 Williams`
 * — which answers "what did I do". A lineup answers "what do I have", and the
 * difference is not cosmetic: a missing tight end is a chip reading `TE 0/1`
 * in the first arrangement and a visibly empty row in the second. In testing, a
 * full 15-round mock finished with two defenses, no tight end and no kicker,
 * and the chips had been reporting that the whole time without anyone noticing.
 *
 * The round is not thrown away, only demoted — "you spent a 4th on a bench
 * receiver" is real information. It moves to quiet meta beside the name.
 *
 * IMPORTANT: the slot precedence here must match `rosterNeeds` in draft.ts
 * exactly. Both fill dedicated slots first and spend what's left on FLEX. If
 * they ever disagree, the needs chip says FLEX is filled while the lineup shows
 * it empty — a contradiction sitting on screen, in the one panel whose whole
 * job is to be believed. `scripts/check-draft.ts` asserts they agree.
 */

const FLEX_ELIGIBLE: FantasyPos[] = ['RB', 'WR', 'TE']

export interface LineupEntry<P> {
  player: P
  /** Draft round they were taken in, 1-based. Rendered as quiet meta. */
  round: number
  /**
   * Rank within a position, lower is better — ADP on the mock board, Sleeper
   * relevance on the live one. The caller decides which, because the two
   * surfaces hold different records. Null falls back to draft order.
   */
  order?: number | null
}

export interface LineupSlot<P> {
  /** 'QB', 'RB1', 'RB2', 'FLEX' — numbered only when the slot repeats. */
  label: string
  /** The underlying slot name, unnumbered. */
  slot: string
  entry: LineupEntry<P> | null
}

export interface Lineup<P> {
  starters: LineupSlot<P>[]
  /** Everyone who didn't crack the lineup, in the order they were drafted. */
  bench: LineupEntry<P>[]
}

/**
 * Best first, then earliest drafted, then a stable index.
 *
 * The final tiebreak matters more than it looks: without it, two players with
 * no ADP and the same round can swap places between renders, and a lineup that
 * reshuffles while you look at it reads as a bug.
 */
function bestFirst<P>(a: [LineupEntry<P>, number], b: [LineupEntry<P>, number]): number {
  const ao = a[0].order ?? Number.POSITIVE_INFINITY
  const bo = b[0].order ?? Number.POSITIVE_INFINITY
  return ao - bo || a[0].round - b[0].round || a[1] - b[1]
}

export function assignLineup<P extends { pos: FantasyPos }>(
  entries: LineupEntry<P>[],
  slots: Record<string, number>,
): Lineup<P> {
  // Indexed so the sort has a stable final tiebreak.
  const pools = new Map<FantasyPos, [LineupEntry<P>, number][]>()
  entries.forEach((e, i) => {
    const pool = pools.get(e.player.pos)
    if (pool) pool.push([e, i])
    else pools.set(e.player.pos, [[e, i]])
  })
  for (const pool of pools.values()) pool.sort(bestFirst)

  const taken = new Set<number>()
  const starters: LineupSlot<P>[] = []

  const take = (pos: FantasyPos): LineupEntry<P> | null => {
    const pool = pools.get(pos)
    if (!pool) return null
    for (const [entry, i] of pool) {
      if (taken.has(i)) continue
      taken.add(i)
      return entry
    }
    return null
  }

  for (const slot of orderSlots(slots)) {
    const need = slots[slot] ?? 0
    if (slot === 'FLEX') continue

    for (let n = 1; n <= need; n++) {
      starters.push({
        // A single slot reads better unnumbered — nobody says "QB1" when there
        // is only one quarterback.
        label: need > 1 ? `${slot}${n}` : slot,
        slot,
        entry: take(slot as FantasyPos),
      })
    }
  }

  /**
   * FLEX last, from whatever the dedicated slots didn't consume.
   *
   * Pooled across RB/WR/TE and re-sorted rather than taken position by
   * position, so the flex gets the best spare player rather than the best
   * spare running back.
   */
  const flexNeed = slots.FLEX ?? 0
  if (flexNeed > 0) {
    const spare: [LineupEntry<P>, number][] = []
    for (const pos of FLEX_ELIGIBLE) {
      for (const pair of pools.get(pos) ?? []) {
        if (!taken.has(pair[1])) spare.push(pair)
      }
    }
    spare.sort(bestFirst)

    for (let n = 1; n <= flexNeed; n++) {
      const pick = spare.find((pair) => !taken.has(pair[1]))
      if (pick) taken.add(pick[1])
      starters.push({
        label: flexNeed > 1 ? `FLEX${n}` : 'FLEX',
        slot: 'FLEX',
        entry: pick ? pick[0] : null,
      })
    }
  }

  // FLEX is inserted in its conventional position rather than appended, so the
  // lineup reads QB · RB · WR · TE · FLEX · DEF · K the way every fantasy site
  // shows it. Sorting by the display order does that without a second pass.
  const rank = orderSlots(slots)
  starters.sort((a, b) => rank.indexOf(a.slot) - rank.indexOf(b.slot))

  const bench = entries.filter((_, i) => !taken.has(i))

  return { starters, bench }
}
