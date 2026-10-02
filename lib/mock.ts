import type { AdpEntry } from './adp'
import type { FantasyPos } from './players'

/**
 * The mock draft engine.
 *
 * Distinct from `lib/draft.ts`, which serves draft day: there, every pick is
 * typed in by a human because Yahoo has no live-draft push API. Here nothing is
 * typed in — the other teams draft themselves off the current ADP market, which
 * is the whole point of practising.
 */

// ---------------------------------------------------------------------------
// Normal distribution
// ---------------------------------------------------------------------------

/** Abramowitz & Stegun 7.1.26 — plenty for a draft board. */
function erf(x: number): number {
  const s = x < 0 ? -1 : 1
  const a = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * a)
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-a * a)
  return s * y
}

function normalCdf(x: number, mean: number, sd: number): number {
  if (sd <= 0) return x < mean ? 0 : 1
  return 0.5 * (1 + erf((x - mean) / (sd * Math.SQRT2)))
}

/** Box–Muller, so opponent picks vary the way real drafts do. */
function gauss(rand: () => number): number {
  let u = 0
  while (u === 0) u = rand()
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand())
}

// ---------------------------------------------------------------------------
// Survival odds
// ---------------------------------------------------------------------------

/**
 * The odds a player is still on the board at `target`, given they're still here
 * at `current`.
 *
 * This is the number the whole feature exists to produce: "who can I actually
 * get at my pick" is the question a mock draft answers and a ranking list does
 * not.
 *
 * Conditioning on the player having survived to `current` matters more than it
 * looks. A back with an ADP of 20 who is somehow still there at pick 40 is
 * visibly sliding; the unconditional odds of him lasting to 58 round to nothing,
 * while the conditional odds are close to even. Without the conditioning the UI
 * would tell you the falling player is unreachable at the exact moment he is
 * the easiest player in the draft to get.
 */
export function survivalOdds(entry: AdpEntry, current: number, target: number): number {
  if (target <= current) return 1
  const survivedToNow = 1 - normalCdf(current, entry.adp, entry.stdev)
  const survivesToTarget = 1 - normalCdf(target, entry.adp, entry.stdev)
  // Long past their ADP the denominator underflows and the ratio stops meaning
  // anything. Everyone left down there is a coin flip on roster need, not ADP.
  if (survivedToNow < 1e-4) return survivesToTarget < 1e-4 ? 0.5 : 1
  return Math.min(1, survivesToTarget / survivedToNow)
}

/**
 * The odds a player is still on the board at `overall`, knowing nothing else.
 *
 * The UNCONDITIONAL twin of `survivalOdds`, and the distinction matters. During
 * a live draft you can see who is left, so the useful question is conditional:
 * "he is here NOW — will he last?" Reading a finished team card you cannot see
 * the board at all, so the only answerable question is the prior: "how often is
 * someone like this still available at pick N?"
 *
 * That is a genuinely weaker claim and everything built on it has to say so. It
 * can support "he was probably there" and can never support "he was there".
 */
export function availabilityAt(entry: AdpEntry, overall: number): number {
  if (overall <= 1) return 1

  /**
   * Truncated at the first pick, and this is not a rounding detail.
   *
   * A normal centred on ADP 1.5 puts real mass below pick 1 — draft positions
   * that do not exist. Untruncated, the consensus 1.1 player came out 57% to be
   * available AT PICK ONE, i.e. 43% likely to have been taken before the draft
   * began. Renormalising over [1, infinity) makes pick 1 exactly certain, which
   * it is, and leaves everything downstream unchanged in shape.
   *
   * `overall - 0.5` is the continuity correction: he is still there when pick N
   * is made if his position is N or later, not strictly greater than N.
   */
  const feasible = 1 - normalCdf(0.5, entry.adp, entry.stdev)
  if (feasible <= 1e-9) return 0
  return Math.min(1, (1 - normalCdf(overall - 0.5, entry.adp, entry.stdev)) / feasible)
}

// ---------------------------------------------------------------------------
// Opponent behaviour
// ---------------------------------------------------------------------------

/**
 * How many of each position a simulated team will hold.
 *
 * ADP alone produces a league where somebody rosters four quarterbacks, because
 * ADP is a market average and not a roster. These caps are the minimum needed to
 * keep the board plausible — everything else is left to the market.
 */
function positionCap(pos: FantasyPos, slots: Record<string, number>): number {
  switch (pos) {
    case 'K':
      return slots.K ?? 1
    case 'DEF':
      return slots.DEF ?? 1
    case 'QB':
      return (slots.QB ?? 1) + 1
    case 'TE':
      return (slots.TE ?? 1) + 1
    default:
      return Infinity
  }
}

export interface SimOptions {
  slots: Record<string, number>
  round: number
  totalRounds: number
  rand?: () => number
}

/**
 * One opponent's pick: the current market, plus the disagreement the market
 * itself reports.
 *
 * Each available player is scored `adp + noise` where the noise is scaled by
 * that player's own observed spread, so consensus picks go near their ADP and
 * genuinely contested ones move around. That's what makes two runs of the same
 * draft slot produce different boards — which is the only way a mock teaches
 * you anything about what you can actually get.
 */
export function simulateAdpPick(
  entries: AdpEntry[],
  taken: Set<string>,
  roster: { pos: FantasyPos }[],
  { slots, round, totalRounds, rand = Math.random }: SimOptions,
): AdpEntry | null {
  const counts = new Map<FantasyPos, number>()
  for (const p of roster) counts.set(p.pos, (counts.get(p.pos) ?? 0) + 1)

  // Nobody spends a real pick on a kicker or defense until the end. ADP puts
  // them around overall 180, which in a deep league lands several rounds too
  // early — rounds, not picks, are what drafters actually reason about.
  const allowLate = round > totalRounds - 2

  /**
   * Out of picks to be clever with.
   *
   * ADP says nothing about a lineup being legal, so a team could spend its last
   * pick on a fifth receiver and finish without a kicker — which a real drafter
   * never does, because those slots have to be filled by someone. When the
   * rounds remaining are no more than the mandatory slots still empty, the
   * choice is made: take one of the things you still need.
   */
  const stillNeeded = (['K', 'DEF'] as FantasyPos[]).filter(
    (p) => (counts.get(p) ?? 0) < (slots[p] ?? 0),
  )
  const roundsLeft = totalRounds - round + 1
  const forced = stillNeeded.length > 0 && roundsLeft <= stillNeeded.length

  let best: AdpEntry | null = null
  let bestScore = Infinity
  let seen = 0

  for (const e of entries) {
    const pos = e.player.pos
    if (taken.has(e.player.id)) continue
    if (forced && !stillNeeded.includes(pos)) continue
    if (!allowLate && (pos === 'K' || pos === 'DEF')) continue
    if ((counts.get(pos) ?? 0) >= positionCap(pos, slots)) continue

    const score = e.adp + gauss(rand) * e.stdev
    if (score < bestScore) {
      bestScore = score
      best = e
    }

    // `entries` is ADP-sorted, so once we've scored this many eligible players
    // the rest are too far down to win: the widest spread on the board is 24,
    // and CANDIDATE_WINDOW comfortably exceeds three of those. Scoring all
    // thousand every pick would be ~285k rolls across a deep draft for a result
    // that never changes.
    if (++seen >= CANDIDATE_WINDOW) break
  }

  return best
}

const CANDIDATE_WINDOW = 100
