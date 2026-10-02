import { fetchAdpBoard } from '@/lib/adp'
import { fetchPlayerPool } from '@/lib/players'
import type { ScoringType } from '@/lib/types'

export const runtime = 'nodejs'
/** Same reasoning as /api/players: never bake a bad upstream day into a build. */
export const dynamic = 'force-dynamic'

const VALID: ScoringType[] = ['standard', 'half_ppr', 'ppr']

/**
 * Serves the merged ADP board to the mock draft.
 *
 * The whole draft is simulated client-side against this one payload — 270 picks
 * with a round trip each would make a practice draft slower than the real one.
 */
export async function GET(req: Request) {
  const raw = new URL(req.url).searchParams.get('scoring')
  const scoring: ScoringType = VALID.includes(raw as ScoringType)
    ? (raw as ScoringType)
    : 'ppr'

  try {
    const board = await fetchAdpBoard(scoring, await fetchPlayerPool())
    return Response.json(board, {
      headers: {
        // Shorter than the player pool: ADP is a rolling seven-day window that
        // moves every day, and a stale market is the one thing this must not be.
        'Cache-Control': 'public, s-maxage=21600, stale-while-revalidate=86400',
      },
    })
  } catch (err) {
    console.error('[adp] board fetch failed', err)
    return Response.json({ error: 'Could not load current draft data' }, { status: 502 })
  }
}
