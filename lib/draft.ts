import type { FantasyPos, PoolPlayer } from './players'

/** A logged pick. `overall` is 1-based and determines which team owns it. */
export interface Pick {
  playerId: string
  overall: number
}

/**
 * Snake order. Odd rounds run 1..N, even rounds run N..1.
 *
 * Everything else in the board derives from this, including roster ownership:
 * because picks are logged in order, overall pick N belongs to whoever holds
 * slot N. That means logging the board also builds your roster for free — no
 * separate "this one's mine" step during a fast draft.
 */
export function overallForRound(round: number, position: number, teams: number): number {
  const slot = round % 2 === 0 ? teams - position + 1 : position
  return (round - 1) * teams + slot
}

export function roundAndPick(
  overall: number,
  teams: number,
): { round: number; pick: number } {
  return {
    round: Math.floor((overall - 1) / teams) + 1,
    pick: ((overall - 1) % teams) + 1,
  }
}

/**
 * Which draft slot owns this overall pick — the inverse of overallForRound.
 *
 * Note this is NOT `roundAndPick().pick`: that's the position within the round,
 * which only equals the slot on odd rounds. In round 2 of an 18-team league,
 * pick 1 belongs to slot 18.
 */
export function slotForOverall(overall: number, teams: number): number {
  const { round, pick } = roundAndPick(overall, teams)
  return round % 2 === 0 ? teams - pick + 1 : pick
}

/** True if `overall` belongs to the team drafting from `position`. */
export function isMyPick(overall: number, position: number, teams: number): boolean {
  const { round, pick } = roundAndPick(overall, teams)
  const mine = round % 2 === 0 ? teams - position + 1 : position
  return pick === mine
}

export function nextPickForMe(
  currentOverall: number,
  position: number,
  teams: number,
  rounds: number,
): { overall: number; round: number } | null {
  for (let r = 1; r <= rounds; r++) {
    const o = overallForRound(r, position, teams)
    if (o >= currentOverall) return { overall: o, round: r }
  }
  return null
}

// ---------------------------------------------------------------------------
// Roster construction
// ---------------------------------------------------------------------------

const FLEX_ELIGIBLE: FantasyPos[] = ['RB', 'WR', 'TE']

/**
 * The order a lineup is conventionally read in.
 *
 * Not cosmetic, and not safe to skip. `roster_slots` is a Postgres jsonb
 * column, and jsonb does not preserve key order — it stores keys sorted by
 * length then bytewise. So a league seeded as {QB,RB,WR,TE,FLEX,DEF,K} reads
 * back as {K,QB,RB,TE,WR,DEF,FLEX}, and every needs chip in the app rendered
 * with the kicker first.
 *
 * This never showed up in the design preview, which passes a JS object literal
 * whose insertion order IS preserved — the preview was right and every real
 * league was wrong, which is the exact pair of conditions that hides a bug.
 * Anything not listed here is appended in the order it was given.
 */
export const SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'DEF', 'K']

export function orderSlots(slots: Record<string, number>): string[] {
  const known = SLOT_ORDER.filter((s) => (slots[s] ?? 0) > 0)
  const rest = Object.keys(slots).filter(
    (s) => (slots[s] ?? 0) > 0 && !SLOT_ORDER.includes(s),
  )
  return [...known, ...rest]
}

export interface SlotStatus {
  slot: string
  need: number
  filled: number
}

/**
 * Fills dedicated slots by position first, then spends leftover RB/WR/TE on
 * FLEX. Anything past that is bench depth and isn't reported as a need.
 */
export function rosterNeeds(
  slots: Record<string, number>,
  // Position is all this reads. Asking for a full PoolPlayer would shut out the
  // mock draft, which carries a slimmer record off the ADP board.
  myPlayers: { pos: FantasyPos }[],
): SlotStatus[] {
  const counts: Partial<Record<FantasyPos, number>> = {}
  for (const p of myPlayers) counts[p.pos] = (counts[p.pos] ?? 0) + 1

  const out: SlotStatus[] = []

  // Conventional order, never the column's — see SLOT_ORDER.
  for (const slot of orderSlots(slots)) {
    if (slot === 'FLEX') continue
    const need = slots[slot] ?? 0
    const pos = slot as FantasyPos
    const have = counts[pos] ?? 0
    const used = Math.min(have, need)
    counts[pos] = have - used
    out.push({ slot, need, filled: used })
  }

  const flexNeed = slots.FLEX ?? 0
  if (flexNeed > 0) {
    const surplus = FLEX_ELIGIBLE.reduce((s, p) => s + (counts[p] ?? 0), 0)
    out.push({ slot: 'FLEX', need: flexNeed, filled: Math.min(surplus, flexNeed) })
  }

  return out
}

export function unfilledSlots(status: SlotStatus[]): string[] {
  return status.filter((s) => s.filled < s.need).map((s) => s.slot)
}

// ---------------------------------------------------------------------------
// Positional runs
// ---------------------------------------------------------------------------

export interface PositionalRun {
  pos: FantasyPos
  count: number
  window: number
}

/**
 * A run is worth surfacing because it's the one piece of board information a
 * human reliably misses while managing their own queue — and in a deep league
 * it's the difference between getting the last startable back and reaching two
 * rounds later.
 */
export function detectRun(
  recent: { pos: FantasyPos }[],
  window = 8,
  threshold = 4,
): PositionalRun | null {
  const slice = recent.slice(-window)
  if (slice.length < threshold) return null

  const counts = new Map<FantasyPos, number>()
  for (const p of slice) counts.set(p.pos, (counts.get(p.pos) ?? 0) + 1)

  let best: PositionalRun | null = null
  for (const [pos, count] of counts) {
    if (pos === 'K' || pos === 'DEF') continue
    if (count >= threshold && (!best || count > best.count)) {
      best = { pos, count, window: slice.length }
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Type-ahead
// ---------------------------------------------------------------------------

/**
 * Ranked name match. A query that starts one of the player's names wins, then
 * Sleeper relevance — so "chr" surfaces Christian McCaffrey before a
 * rank-9999999 practice-squad Chris, which is what makes two-keystroke logging
 * viable during a fast draft.
 *
 * "Starts a name" means any part of it, not just the first: people type
 * surnames, so "jeff" has to reach Justin Jefferson. Ranking that as a plain
 * substring put two rank-300 wideouts named Jeff above him, because they
 * happened to match at offset zero — the exact failure this bucketing exists to
 * prevent, pointed the wrong way. Everything else is a loose substring and
 * falls below every name match, however obscure the player.
 */
export function searchPool(
  pool: PoolPlayer[],
  query: string,
  taken: Set<string>,
  limit = 8,
): PoolPlayer[] {
  const q = query.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (!q) return []

  const hits: { p: PoolPlayer; score: number }[] = []
  for (const p of pool) {
    if (taken.has(p.id)) continue
    // The pool crosses a network boundary as an unchecked cast. One malformed
    // row shouldn't take the whole board down mid-draft.
    if (!p.search) continue
    if (p.search.indexOf(q) === -1) continue
    // A multi-word query ("justin jeff") normalizes to a run that spans the gap
    // between names, so it can only ever match `search` — fall back to that.
    const startsName =
      p.search.startsWith(q) || (p.tokens?.some((t) => t.startsWith(q)) ?? false)
    hits.push({ p, score: (startsName ? 0 : 1_000_000) + p.rank })
  }

  hits.sort((a, b) => a.score - b.score || a.p.name.localeCompare(b.p.name))
  return hits.slice(0, limit).map((h) => h.p)
}
