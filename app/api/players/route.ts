import { fetchPlayerPool } from '@/lib/players'

export const runtime = 'nodejs'
/**
 * Dynamic on purpose. Prerendering this at build time would bake in whatever
 * Sleeper returned then — including a 502 if Sleeper happened to be down
 * during a deploy, which would then be served for a full day. Freshness comes
 * from the in-process memo in lib/players.ts plus the CDN header below.
 */
export const dynamic = 'force-dynamic'

/**
 * Serves the slimmed player pool (~65KB) to the draft board.
 *
 * The board does all matching locally against this — a round trip per
 * keystroke would make pick logging unusable on a shortened clock.
 */
export async function GET() {
  try {
    const pool = await fetchPlayerPool()
    return Response.json(
      { pool },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=86400, stale-while-revalidate=604800',
        },
      },
    )
  } catch (err) {
    console.error('[players] pool fetch failed', err)
    return Response.json({ error: 'Could not load the player pool' }, { status: 502 })
  }
}
