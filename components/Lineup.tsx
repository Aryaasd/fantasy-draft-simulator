import type { FantasyPos } from '@/lib/players'
import type { Lineup as LineupData, LineupEntry } from '@/lib/lineup'
import { InjuryFlag } from '@/components/InjuryFlag'
import { PlayerFace } from '@/components/PlayerFace'

/**
 * A roster shown as a starting lineup rather than a draft log.
 *
 * Presentation only — `lib/lineup.ts` does the assignment, the same split as
 * `lib/room.ts` / `TheRoom.tsx`. Shared by the mock and the live board so the
 * two can't drift apart.
 *
 * The empty rows are the point. `TE 0/1` in a chip is information you can look
 * at for fifteen rounds without registering; an empty TE row sitting in your
 * lineup is not.
 */

/** Everything this needs to render a player, and nothing more. */
interface Displayable {
  id: string
  name: string
  pos: FantasyPos
  team: string
  injury: string | null
}

/**
 * The slot label, coloured by what is actually filling it.
 *
 * For a dedicated slot that is just the slot's own position. For FLEX it is the
 * position of whoever is in it, which is the more useful fact: a glance tells
 * you whether your flex is a back or a receiver without reading the name.
 */
function slotColour(slot: string, entry: { player: { pos: string } } | null): string {
  const pos = slot === 'FLEX' && entry ? entry.player.pos : slot.replace(/\d+$/, '')
  return `pos-${pos.toLowerCase()}`
}

function Row<P extends Displayable>({ label, slot, entry }: { label: string; slot: string; entry: LineupEntry<P> | null }) {
  if (!entry) {
    return (
      <li className="lineup-row lineup-empty">
        <span className={`lineup-slot ${slotColour(slot, null)}`}>{label}</span>
        {/* Holds the column so empty rows line up with filled ones. */}
        <span className="face-gap" aria-hidden="true" />
        <span className="lineup-name">—</span>
        <span className="lineup-meta">empty</span>
      </li>
    )
  }

  const { player, round } = entry
  return (
    <li className="lineup-row">
      <span className={`lineup-slot ${slotColour(slot, entry)}`}>{label}</span>
      <PlayerFace id={player.id} pos={player.pos} team={player.team} />
      <span className="lineup-name">
        <strong>{player.name}</strong>{' '}
        <span className="ac-meta">{player.team}</span>
        {player.injury && (
          <>
            {' '}
            <InjuryFlag status={player.injury} />
          </>
        )}
      </span>
      {/* The round isn't deleted, only demoted. "You spent a 4th on a bench
          receiver" is real information, and it's the one thing the old
          round-ordered list said better than this one. */}
      <span className="lineup-meta">R{round}</span>
    </li>
  )
}

export function Lineup<P extends Displayable>({
  lineup,
  empty = 'Nothing yet.',
}: {
  lineup: LineupData<P>
  /** Shown instead of the bench heading before anyone is drafted. */
  empty?: string
}) {
  const { starters, bench } = lineup
  const drafted = starters.some((s) => s.entry) || bench.length > 0

  return (
    <div className="lineup">
      <ul className="lineup-list">
        {starters.map((s) => (
          <Row key={s.label} label={s.label} slot={s.slot} entry={s.entry} />
        ))}
      </ul>

      {bench.length > 0 && (
        <div className="lineup-bench">
          <div className="stat-label">Bench</div>
          <ul className="lineup-list">
            {bench.map((e) => (
              <li key={e.player.id} className="lineup-row">
                <span className={`lineup-slot lineup-slot-bench pos-${e.player.pos.toLowerCase()}`}>
                  {e.player.pos}
                </span>
                <PlayerFace id={e.player.id} pos={e.player.pos} team={e.player.team} size={22} />
                <span className="lineup-name">
                  {e.player.name} <span className="ac-meta">{e.player.team}</span>
                  {e.player.injury && (
                    <>
                      {' '}
                      <InjuryFlag status={e.player.injury} />
                    </>
                  )}
                </span>
                <span className="lineup-meta">R{e.round}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {!drafted && <p className="ac-meta lineup-hint">{empty}</p>}
    </div>
  )
}
