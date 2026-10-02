/**
 * Turning Sleeper's injury codes into something a beginner can act on.
 *
 * Three problems with showing the raw field, all of which this file exists to
 * fix.
 *
 * **The codes are jargon.** PUP, NFI, DNR, IR mean entirely different things
 * and a first-time player knows none of them. The guide's whole premise is "no
 * jargon we haven't handed you first" (lib/basics.ts), and a bare `PUP` next to
 * a player's name breaks that promise at the exact moment somebody is deciding
 * whether to spend a pick.
 *
 * **Not all of them are injuries.** `Sus` is a suspension and `DNR` is a
 * contract holdout — the player is perfectly healthy. Rendering those through
 * something labelled "injury" tells people the wrong thing about why he's
 * unavailable, which changes whether he's worth drafting at all.
 *
 * **"Questionable" does not mean in August what it means in October.** On a
 * game day it's a formal designation, roughly a coin flip to play. In camp it's
 * closer to "something is being managed" — and 41 of the current top 200 carry
 * it, including several first-rounders. Styling all of that the same danger red
 * as a season-ending IR both overstates the camp knocks and buries the players
 * who genuinely won't take a snap.
 *
 * What this file will NOT do is tell you whether he'll be back. That's
 * current-season fact, it changes daily, and lib/prompt.ts already names
 * "current injuries, suspensions, or roster status" as something that must be
 * searched rather than recalled. So this classifies and explains the flag, and
 * the "will he actually play?" question goes to the grounded ask — the same
 * split the static guide and the live model already run on.
 */

/** Longest an unrecognised code may render before it distorts the row. */
const MAX_CODE_CHARS = 14

function truncate(code: string): string {
  return code.length <= MAX_CODE_CHARS ? code : `${code.slice(0, MAX_CODE_CHARS - 1)}\u2026`
}

export type InjurySeverity = 'out' | 'doubtful' | 'questionable' | 'unknown'

export interface InjuryInfo {
  /** Exactly what the source said, so nothing is silently rewritten. */
  code: string
  /** Plain English, expanded. */
  label: string
  severity: InjurySeverity
  /** One sentence you can act on without knowing the vocabulary. */
  meaning: string
  /** True when he is available-but-not-playing rather than hurt. */
  nonMedical: boolean
}

interface Entry {
  label: string
  severity: InjurySeverity
  meaning: string
  nonMedical?: boolean
}

/**
 * Keyed on the code with punctuation stripped, because the same status arrives
 * as both `IR-R` and `IRR` depending on where in Sleeper's payload it came
 * from.
 */
const CODES: Record<string, Entry> = {
  IR: {
    label: 'Injured reserve',
    severity: 'out',
    meaning:
      'Out at least four games. Most leagues give you an IR slot so he does not eat a bench spot.',
  },
  IRR: {
    label: 'Injured reserve, may return',
    severity: 'out',
    meaning:
      'Eligible to come back later in the season. A stash, not a starter.',
  },
  PUP: {
    label: 'Physically unable to perform',
    severity: 'out',
    meaning:
      'Started camp hurt. If he opens the season on this list he misses at least the first four games.',
  },
  PUPR: {
    label: 'Physically unable to perform',
    severity: 'out',
    meaning:
      'Started camp hurt and is eligible to return during the season. Expect to wait.',
  },
  NFI: {
    label: 'Non-football injury',
    severity: 'out',
    meaning: 'Hurt away from the field. Treated like PUP — expect him to miss time.',
  },
  NFIR: {
    label: 'Non-football injury, may return',
    severity: 'out',
    meaning: 'Hurt away from the field, eligible to return later in the season.',
  },
  OUT: {
    label: 'Out',
    severity: 'out',
    meaning: 'Ruled out for the game. He is not playing.',
  },
  DOUBTFUL: {
    label: 'Doubtful',
    severity: 'doubtful',
    meaning: 'Very unlikely to play. Treat him as out unless you hear otherwise.',
  },
  QUESTIONABLE: {
    label: 'Questionable',
    severity: 'questionable',
    meaning:
      'Something is being managed. Before the season this usually means a camp knock rather than a game-day call — worth asking about rather than avoiding on sight.',
  },
  COV: {
    label: 'COVID list',
    severity: 'questionable',
    meaning: 'On the COVID list. Availability depends on when he clears.',
  },
  SUS: {
    label: 'Suspended',
    severity: 'out',
    meaning:
      'Not hurt — he misses a set number of games, then returns at full health. That can make him a bargain if you can afford to wait.',
    nonMedical: true,
  },
  DNR: {
    label: 'Has not reported',
    severity: 'out',
    meaning:
      'A contract situation rather than an injury, so it can end at any moment.',
    nonMedical: true,
  },
  NA: {
    label: 'Not active',
    severity: 'out',
    meaning: 'Not on the active roster right now.',
  },
}

/**
 * Describe a raw status, or null when the player carries no flag.
 *
 * An unrecognised code is passed through rather than dropped: a status we
 * cannot explain is still a status the drafter should see, and silently hiding
 * it would be the one genuinely unsafe option.
 */
export function describeInjury(raw: string | null | undefined): InjuryInfo | null {
  if (typeof raw !== 'string') return null

  // Collapse whitespace before anything renders it. This value is upstream
  // JSON, and a newline in the middle of a pill breaks the row it sits in.
  const code = raw.replace(/\s+/g, ' ').trim()
  if (!code) return null

  const key = code.toUpperCase().replace(/[^A-Z]/g, '')
  const entry = CODES[key]

  if (!entry) {
    return {
      code: truncate(code),
      // Known codes get a curated label; an unknown one is shown as-is, which
      // means its length is whatever the upstream sent. Capped so a malformed
      // field can't stretch a pill across the board.
      label: truncate(code),
      severity: 'unknown',
      meaning: 'Carrying a status flag. Ask for the detail before you spend a pick.',
      nonMedical: false,
    }
  }

  return {
    code,
    label: entry.label,
    severity: entry.severity,
    meaning: entry.meaning,
    nonMedical: entry.nonMedical ?? false,
  }
}

/** Flagged players on a roster, worst first, for a single summary line. */
export function flaggedPlayers<T extends { name: string; injury: string | null }>(
  players: T[],
): { player: T; info: InjuryInfo }[] {
  const rank: Record<InjurySeverity, number> = {
    out: 0,
    doubtful: 1,
    questionable: 2,
    unknown: 3,
  }
  return players
    .map((player) => ({ player, info: describeInjury(player.injury) }))
    .filter((r): r is { player: T; info: InjuryInfo } => r.info !== null)
    .sort(
      (a, b) =>
        rank[a.info.severity] - rank[b.info.severity] ||
        String(a.player.name ?? '').localeCompare(String(b.player.name ?? '')),
    )
}

/**
 * How a roster's health reads as one sentence.
 *
 * Deliberately states the flag and nothing about whether he'll be back — that
 * is the grounded ask's job, not a string built on a 24-hour-old cache.
 */
export function rosterHealthLine(
  flagged: { player: { name: string }; info: InjuryInfo }[],
): string | null {
  if (flagged.length === 0) return null
  // The name comes from the player pool, which crosses a network boundary. A
  // missing one must not reach the member as the literal string "undefined".
  const names = flagged
    .map(({ player, info }) => {
      const name =
        typeof player.name === 'string' && player.name.trim()
          ? player.name.trim()
          : 'An unnamed player'
      return `${name} (${info.label.toLowerCase()})`
    })
    .join(', ')
  return flagged.length === 1
    ? `One player on your roster is flagged: ${names}.`
    : `${flagged.length} players on your roster are flagged: ${names}.`
}
