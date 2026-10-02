import type { FantasyPos, PoolPlayer } from './players'
import type { ScoringType } from './types'

/**
 * Just enough of a player to draft them.
 *
 * The mock picks off a ranked board rather than a search box, so it needs none
 * of the type-ahead machinery `PoolPlayer` carries. Shipping the full record
 * tripled the payload for fields nothing reads.
 */
export interface MarketPlayer {
  id: string
  name: string
  pos: FantasyPos
  team: string
  injury: string | null
}

/**
 * A player's current draft market: where people are actually taking them, and
 * how much they disagree.
 */
export interface AdpEntry {
  player: MarketPlayer
  /** Mean overall pick across the sampled drafts. */
  adp: number
  /** Spread of that mean. Drives both opponent variance and survival odds. */
  stdev: number
  /** How many of the sampled drafts took this player at all. */
  timesDrafted: number
  /** False for the Sleeper-ranked tail past ADP coverage — see `board()`. */
  observed: boolean
}

export interface AdpBoard {
  /** Every draftable player, best first. Position in this array is the consensus. */
  entries: AdpEntry[]
  meta: {
    format: string
    totalDrafts: number
    /** The rolling window the sample covers, e.g. 2026-08-09 → 2026-08-16. */
    startDate: string
    endDate: string
    /** How many entries came from real drafts rather than the ranked tail. */
    observedCount: number
  }
}

/**
 * Fantasy Football Calculator's public ADP API — real mock drafts from the last
 * seven days, no auth, no key.
 *
 * This is the one number the model genuinely cannot supply: "how people are
 * drafting right now" is a live market, and a mock built on the model's recall
 * would be rehearsing last season's draft.
 */
const FFC_URL = 'https://fantasyfootballcalculator.com/api/v1/adp'

/**
 * FFC serves 8/10/12/14 and errors on anything else, so an 18-team league can't
 * ask for its own size. It doesn't need to: the `teams` parameter only changes
 * how `adp_formatted` renders the round — the underlying order and sample are
 * identical across sizes. We ask for 12 and use the ordering.
 */
const FFC_TEAMS = 12

const FORMAT: Record<ScoringType, string> = {
  standard: 'standard',
  half_ppr: 'half-ppr',
  ppr: 'ppr',
}

interface FfcPlayer {
  name?: string
  position?: string
  team?: string
  adp?: number
  stdev?: number
  times_drafted?: number
}

interface FfcResponse {
  status?: string
  meta?: { total_drafts?: number; start_date?: string; end_date?: string }
  players?: FfcPlayer[]
}

// ---------------------------------------------------------------------------
// Matching FFC names onto Sleeper ids
// ---------------------------------------------------------------------------

/** Suffixes FFC prints and Sleeper mostly doesn't. Dropped from both sides. */
const SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v'])

/**
 * A join key that survives the two sources disagreeing about punctuation,
 * accents, and generational suffixes.
 *
 * Matching raw names gets 216 of 261. Folding diacritics (Eddy Piñeiro),
 * dropping suffixes (James Cook III, Marvin Harrison Jr.), and routing team
 * defenses through their abbreviation instead gets all 261 — worth the care,
 * because an unmatched player silently vanishes from the draft board.
 */
function nameKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .split(/\s+/)
    .filter((t) => t && !SUFFIXES.has(t))
    .join('')
}

/** FFC calls kickers PK. Everything else lines up. */
function normalizePos(pos: string): FantasyPos | null {
  const p = pos === 'PK' ? 'K' : pos
  return ['QB', 'RB', 'WR', 'TE', 'K', 'DEF'].includes(p) ? (p as FantasyPos) : null
}

// ---------------------------------------------------------------------------
// Fetch + cache
// ---------------------------------------------------------------------------

const TTL_MS = 6 * 3_600_000 // ADP is a 7-day rolling window; it moves daily.

const memo = new Map<ScoringType, { board: AdpBoard; at: number }>()

/**
 * The full draft board for a scoring format, best player first.
 *
 * ADP covers roughly the first 190 picks. An 18-team league drafting 15 rounds
 * needs 270, so everything past the observed market is appended in Sleeper rank
 * order with `observed: false` and a synthetic ADP that continues the curve.
 * Without that tail the last third of a deep draft would have no board at all;
 * with it, the UI can still be honest about where the real data stops.
 */
export async function fetchAdpBoard(
  scoring: ScoringType,
  /**
   * The Sleeper pool to join against, supplied by the caller.
   *
   * Injected rather than imported so this module has no runtime dependency on
   * `players.ts` — Node's type-stripping loader, which the check script runs
   * under, can't resolve extensionless value imports the way the bundler can.
   */
  pool: PoolPlayer[],
): Promise<AdpBoard> {
  const hit = memo.get(scoring)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.board

  let raw: FfcResponse
  try {
    const res = await fetch(
      `${FFC_URL}/${FORMAT[scoring]}?teams=${FFC_TEAMS}&year=${new Date().getFullYear()}`,
      { cache: 'no-store' },
    )
    if (!res.ok) throw new Error(`ADP upstream ${res.status}`)
    raw = (await res.json()) as FfcResponse
  } catch (e) {
    // Serve the last good board rather than dropping to no market at all.
    if (hit) return hit.board
    throw e
  }

  const board = merge(pool, raw, scoring)
  memo.set(scoring, { board, at: Date.now() })
  return board
}

/**
 * How deep the served board goes.
 *
 * The deepest plausible league here is 18 teams over 15 rounds — 270 picks —
 * and the best-available list wants room past the final pick. Everyone below
 * this is a player no draft can reach, so they're weight on the wire and
 * nothing else.
 */
const BOARD_DEPTH = 600

/**
 * Minimum players per position the board must carry, whatever the market says.
 *
 * The ranked tail is ordered by Sleeper relevance, which in the off-season
 * buries kickers and defenses below the depth cut. Preseason that never showed,
 * because ADP itself covered them. In October — when Fantasy Football Calculator
 * sees barely a hundred drafts a week and only ~29 players have observed ADP —
 * the board came back with RB, WR, QB, TE and K but *no defenses at all*. Every
 * team needs one, so the final round could not fill and a 270-pick draft
 * stopped at 252.
 *
 * A draft board that cannot complete a legal lineup is broken no matter how it
 * got that way, so coverage is now guaranteed before relevance. 32 is one per
 * NFL team, which covers any league size.
 */
const MIN_PER_POSITION = 32
const ALL_POSITIONS: FantasyPos[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']

function slim(p: PoolPlayer): MarketPlayer {
  return { id: p.id, name: p.name, pos: p.pos, team: p.team, injury: p.injury }
}

function merge(pool: PoolPlayer[], raw: FfcResponse, scoring: ScoringType): AdpBoard {
  const byKey = new Map<string, PoolPlayer>()
  const defByTeam = new Map<string, PoolPlayer>()
  for (const p of pool) {
    if (p.pos === 'DEF') defByTeam.set(p.team, p)
    const k = `${p.pos}|${nameKey(p.name)}`
    // Sleeper carries duplicates for some names; the pool is rank-sorted, so
    // the first is the one people mean.
    if (!byKey.has(k)) byKey.set(k, p)
  }

  const entries: AdpEntry[] = []
  const used = new Set<string>()

  for (const row of raw.players ?? []) {
    if (!row.name || !row.position || typeof row.adp !== 'number') continue
    const pos = normalizePos(row.position)
    if (!pos) continue

    const player =
      pos === 'DEF'
        ? row.team
          ? defByTeam.get(row.team)
          : undefined
        : byKey.get(`${pos}|${nameKey(row.name)}`)
    if (!player || used.has(player.id)) continue

    used.add(player.id)
    entries.push({
      player: slim(player),
      adp: row.adp,
      // A player only a handful of drafts touched reports a tiny spread that
      // would make the sim treat them as a certainty. Floor it.
      stdev: Math.max(row.stdev ?? 0, 3),
      timesDrafted: row.times_drafted ?? 0,
      observed: true,
    })
  }

  entries.sort((a, b) => a.adp - b.adp)
  const observedCount = entries.length
  const lastAdp = entries.length ? entries[entries.length - 1].adp : 0

  /**
   * The tail: everyone the market hasn't reached, in Sleeper's relevance order.
   * Their synthetic ADP just continues past the observed board so ordering and
   * survival math keep working; the wide stdev says "nobody really knows".
   *
   * Positional coverage is reserved BEFORE relevance — see MIN_PER_POSITION.
   * Taking purely the best-ranked players leaves a board that looks sensible
   * and cannot finish a draft.
   */
  const remaining = pool
    .filter((p) => !used.has(p.id))
    .sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))

  const reserved = new Set<string>()
  for (const pos of ALL_POSITIONS) {
    let need = MIN_PER_POSITION - entries.filter((e) => e.player.pos === pos).length
    if (need <= 0) continue
    for (const p of remaining) {
      if (need <= 0) break
      if (p.pos !== pos || reserved.has(p.id)) continue
      reserved.add(p.id)
      need--
    }
  }

  const tail = [
    ...remaining.filter((p) => reserved.has(p.id)),
    ...remaining.filter((p) => !reserved.has(p.id)),
  ].slice(0, Math.max(reserved.size, BOARD_DEPTH - entries.length))
  tail.forEach((player, i) => {
    entries.push({
      player: slim(player),
      adp: lastAdp + 1 + i,
      stdev: 24,
      timesDrafted: 0,
      observed: false,
    })
  })

  return {
    entries,
    meta: {
      format: FORMAT[scoring],
      totalDrafts: raw.meta?.total_drafts ?? 0,
      startDate: raw.meta?.start_date ?? '',
      endDate: raw.meta?.end_date ?? '',
      observedCount,
    },
  }
}
