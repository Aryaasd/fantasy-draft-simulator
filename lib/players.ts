export type FantasyPos = 'QB' | 'RB' | 'WR' | 'TE' | 'K' | 'DEF'

export const FANTASY_POSITIONS: FantasyPos[] = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']

export interface PoolPlayer {
  id: string
  name: string
  pos: FantasyPos
  team: string
  /**
   * Sleeper's own relevance ranking. Used ONLY to order the type-ahead so the
   * obvious guy surfaces on two keystrokes.
   *
   * This is not ADP and must never be shown as draft value — it has ties (two
   * players share rank 1) and reflects general relevance, not positional value
   * in an 18-team half-PPR league.
   */
  rank: number
  injury: string | null
  /** Lowercased, punctuation-stripped, for matching. */
  search: string
  /**
   * The same name split into normalized parts.
   *
   * People type surnames — "jeff" means Jefferson, not Jeff. Matching that
   * against `search` alone puts it 6 characters in, indistinguishable from a
   * mid-name accident, so the type-ahead needs to know where each part starts.
   * Kept as parts rather than offsets so suffixes ("Jr.") and middles are all
   * just entries, not special cases.
   */
  tokens: string[]
}

interface SleeperPlayer {
  player_id?: string
  first_name?: string
  last_name?: string
  full_name?: string
  search_full_name?: string
  position?: string
  team?: string | null
  active?: boolean
  search_rank?: number
  injury_status?: string | null
}

const SLEEPER_URL = 'https://api.sleeper.app/v1/players/nfl'
const UNRANKED = 9_999_999
const TTL_MS = 86_400_000 // 24h — Sleeper asks for at most one pull per day

/**
 * In-process cache of the slimmed pool.
 *
 * Next's data cache cannot hold the upstream response (it caps at 2MB; the raw
 * payload is ~19MB uncompressed), so `next: { revalidate }` silently does
 * nothing here. Without this memo every request would re-pull 15MB from
 * Sleeper — which on draft day means 18 people each waiting on it. We cache
 * the *slimmed* result instead, which is ~65KB.
 */
let memo: { pool: PoolPlayer[]; at: number } | null = null

export function normalize(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, '')
}

/**
 * Fetches the current NFL player pool from Sleeper.
 *
 * Sleeper's player database is public and unauthenticated, and it is current
 * for the 2026 season — which is why it's used here even though the league
 * itself is on Yahoo. It gives the draft board real names, teams, positions,
 * and injury flags without an OAuth dependency, and it's the piece the model
 * cannot supply from memory.
 *
 * The raw payload is ~15MB, so it is cached for 24h (Sleeper asks callers not
 * to pull it more than once a day) and slimmed to ~65KB before it ever reaches
 * a browser.
 */
export async function fetchPlayerPool(): Promise<PoolPlayer[]> {
  if (memo && Date.now() - memo.at < TTL_MS) return memo.pool

  // `no-store` rather than `next: { revalidate }` — the payload is far past the
  // 2MB data-cache ceiling, so the framework cache would only log a warning on
  // every call. The memo above plus the route's Cache-Control header are what
  // actually keep this to roughly one upstream pull per day.
  const res = await fetch(SLEEPER_URL, { cache: 'no-store' })

  if (!res.ok) {
    // Serve a stale pool rather than breaking the board mid-draft.
    if (memo) return memo.pool
    throw new Error(`Sleeper player fetch failed: ${res.status}`)
  }

  const raw = (await res.json()) as Record<string, SleeperPlayer>
  const pool: PoolPlayer[] = []

  for (const [id, p] of Object.entries(raw)) {
    const pos = p.position as FantasyPos | undefined
    if (!pos || !FANTASY_POSITIONS.includes(pos)) continue
    if (!p.active || !p.team) continue

    // Team defenses have no full_name — they come through as
    // first_name "Houston" / last_name "Texans" with player_id "HOU".
    const name =
      p.full_name?.trim() ||
      [p.first_name, p.last_name].filter(Boolean).join(' ').trim()
    if (!name) continue

    pool.push({
      id: p.player_id || id,
      name,
      pos,
      team: p.team,
      rank: typeof p.search_rank === 'number' ? p.search_rank : UNRANKED,
      injury: p.injury_status || null,
      search: p.search_full_name || normalize(name),
      tokens: name.split(/[\s.'’-]+/).map(normalize).filter(Boolean),
    })
  }

  pool.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name))
  memo = { pool, at: Date.now() }
  return pool
}
