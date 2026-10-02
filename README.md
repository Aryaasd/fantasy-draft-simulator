# Mock Draft

A fantasy football mock draft simulator built on live average draft position.
Pick a slot, and eleven simulated opponents draft against you off real market
data — then it grades the team you came out with.

No account, no database, no API keys. Clone it and run it.

```bash
npm install
npm run dev
```

---

## What it does

**Drafts against the real market.** Opponents don't pick off a static ranking.
Every pick is drawn from current average draft position published by
[Fantasy Football Calculator](https://fantasyfootballcalculator.com), scored as
`adp + noise` where the noise is scaled by that player's *own* observed spread.
Consensus picks land near their ADP; genuinely contested ones move around. Two
runs from the same slot produce different boards, which is the only way a mock
teaches you anything about what you can actually get.

**Tells you who will still be there.** The column nothing else has. For every
available player it computes the odds he survives to your *next* turn, from a
normal distribution over his observed ADP spread — conditioned on him still
being here now:

```
P(lasts to target | still available at current)
  = P(position ≥ target) / P(position ≥ current)
```

Conditioning matters more than it looks. A back with an ADP of 20 who is somehow
still there at pick 40 is visibly sliding. The unconditional odds of him lasting
to 58 round to nothing; the conditional odds are far better. Without it the UI
tells you the falling player is unreachable at the exact moment he is the
easiest player in the draft to get.

**Advises without nagging.** One collapsed line above the board. Open it and it
scores *positions* by what waiting costs:

```
cost = P(the best one is gone by your next pick) × (how much worse your fallback is)
```

Both halves are derived. It behaves correctly at both ends of a draft without
special-casing: in round one every slot is empty so need can't discriminate and
it reduces to "take the steepest drop-off", and by round ten need dominates.

**Grades the draft.** Ranks your starters slot-by-slot against every other team,
then curves. An incomplete lineup caps the grade outright — measured, a drafter
who always takes the top of the board finishes *first* on raw starter strength
while having no quarterback, and a grade that rewards that is worse than none.

**Plans ahead.** A separate sheet showing where your picks land and who's
realistically there when they do, with the odds attached.

## How it's put together

```
lib/adp.ts        live ADP, joined onto the Sleeper player pool
lib/mock.ts       the simulation, survival odds, availability priors
lib/draft.ts      snake order, roster construction, positional runs
lib/lineup.ts     a roster arranged as a starting lineup
lib/suggest.ts    the cost-of-waiting model
lib/analysis.ts   post-draft grading
lib/plan.ts       the pre-draft sheet
lib/room.ts       every team's shape, ranked by trade fit
```

Two public APIs, no auth on either: **Sleeper** for the player pool, **Fantasy
Football Calculator** for ADP. Names are joined across them by a key that folds
diacritics, drops generational suffixes and routes defenses through team
abbreviations — naive matching gets 216 of 261, this gets all of them.

## Tests

```bash
npm run check        # lint, typecheck, theme contrast, draft logic
npm run check:draft  # ~210 assertions, hits both live APIs
```

The draft checks deliberately hit the real APIs, because the failure actually
worth catching is the join between them breaking when a name changes upstream.

A few of them exist because of specific bugs:

- **ADP is a 12-team pick number.** Differencing it against an 18-team pick
  number reported a defense taken at #248 as the best value of the draft. Value
  is measured in board position now.
- **Normal distributions put mass on picks that don't exist.** Untruncated, the
  consensus 1.1 came out 57% available *at pick one*.
- **`roster_slots` round-trips through Postgres jsonb**, which sorts keys by
  length. Every needs chip rendered kicker-first on real data while looking
  perfect in the design preview.
- **Sleeper's relevance order buries defenses.** Mid-season, when barely a
  hundred mock drafts exist to sample, the board came back with no defenses at
  all and a 270-pick draft stopped at 252.

## A note on seasonality

ADP comes from real mock drafts, so coverage tracks the calendar: thousands of
drafts a week in August, barely a hundred in October. The board backfills from
Sleeper's rankings and guarantees positional coverage either way, so a draft
always completes — but the market signal is richest in preseason.

## Stack

TypeScript · Next.js 16 (App Router) · React 19 · no CSS framework

Three-state theming (light/dark/system) with WCAG AA contrast asserted in CI
across every token pair, in both themes.
