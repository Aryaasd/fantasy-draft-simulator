import type { ScoringType } from './types.ts'

/**
 * Defaults for a league nobody has configured yet.
 *
 * Every one of these is editable in the UI before a draft starts — they exist
 * so the app is usable the instant it loads, with no setup screen standing
 * between you and a draft.
 */
export const DEFAULT_SLOTS: Record<string, number> = {
  QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DEF: 1, K: 1,
}

export const DEFAULT_TEAMS = 12
export const DEFAULT_SCORING: ScoringType = 'ppr'

/** Starters, plus six bench spots — the common shape for a 12-team league. */
export const DEFAULT_ROUNDS =
  Object.values(DEFAULT_SLOTS).reduce((a, b) => a + b, 0) + 6
