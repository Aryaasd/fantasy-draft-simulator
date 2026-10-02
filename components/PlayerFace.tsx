'use client'

import { useState } from 'react'
import type { FantasyPos } from '@/lib/players'

/**
 * A player's face, or their team's shield.
 *
 * Sleeper is already the source of our player pool, and `PoolPlayer.id` IS the
 * Sleeper id — so headshots cost nothing but a URL. Verified against the live
 * CDN before this was written, including an obscure practice-squad receiver.
 *
 * Defenses are the exception and would 403 on the player path: a team defense's
 * id is its abbreviation, not a person, so it resolves to the team logo. That
 * is also the right picture for it.
 *
 * Plain <img> rather than next/image on purpose. These are 28px thumbnails from
 * a CDN built to serve them, and routing sixty of them per board through our own
 * optimizer would add server work to save nothing.
 */

const THUMB = (id: string) => `https://sleepercdn.com/content/nfl/players/thumb/${id}.jpg`
const LOGO = (team: string) => `https://sleepercdn.com/images/team_logos/nfl/${team.toLowerCase()}.png`

export function PlayerFace({
  id,
  pos,
  team,
  size = 26,
}: {
  id: string
  pos: FantasyPos
  team: string
  size?: number
}) {
  const [broken, setBroken] = useState(false)

  const src = pos === 'DEF' ? (team ? LOGO(team) : null) : THUMB(id)

  // A missing picture must never leave a hole in the row, so the fallback is
  // the position tag doing double duty — still colour-coded, still meaningful.
  if (!src || broken) {
    return (
      <span
        className={`face face-blank pos-${pos.toLowerCase()}`}
        style={{ width: size, height: size }}
        aria-hidden="true"
      >
        {pos === 'DEF' ? 'D' : pos.charAt(0)}
      </span>
    )
  }

  return (
    /* eslint-disable-next-line @next/next/no-img-element --
       Deliberate, and explained at the top of this file: these are 26px
       thumbnails from a CDN built to serve them. Routing sixty per board
       through next/image would add server work and a billable transform to
       save nothing, and LCP is never one of these. */
    <img
      className={`face${pos === 'DEF' ? ' face-logo' : ''}`}
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setBroken(true)}
      style={{ width: size, height: size }}
    />
  )
}

/**
 * The position, colour-coded.
 *
 * Every fantasy site colours positions and people read them faster than they
 * read the letters, so the colour is carrying real information rather than
 * decorating. Colour is never the ONLY signal — the letters are always there —
 * which is what keeps it legible to anyone who can't tell the two greens apart.
 */
export function PosTag({ pos, className = '' }: { pos: FantasyPos | string; className?: string }) {
  return <span className={`pos-tag pos-${String(pos).toLowerCase()} ${className}`}>{pos}</span>
}
