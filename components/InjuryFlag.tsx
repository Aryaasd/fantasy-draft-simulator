import { describeInjury } from '@/lib/injury'

/**
 * A player's status, tiered by how much it should change your pick.
 *
 * Everything used to render in the same danger red, which made a season-ending
 * IR and a camp-managed "Questionable" look identical — and since 41 of the
 * current top 200 carry a flag, that meant either ignoring all of them or
 * flinching at all of them. Neither is what a drafter needs.
 *
 * The tooltip carries the plain-English meaning, so the abbreviation on the
 * board stays short enough to scan during a live pick while the explanation is
 * one hover away.
 */
export function InjuryFlag({
  status,
  /** `full` also prints the expanded label; dense lists stay abbreviated. */
  variant = 'short',
}: {
  status: string | null | undefined
  variant?: 'short' | 'full'
}) {
  const info = describeInjury(status)
  if (!info) return null

  return (
    <span
      className={`inj inj-${info.severity}`}
      title={`${info.label} — ${info.meaning}`}
    >
      {info.nonMedical && (
        <span aria-hidden="true" className="inj-dot">
          §
        </span>
      )}
      {variant === 'full' ? info.label : info.code}
      <span className="sr-only"> — {info.meaning}</span>
    </span>
  )
}
