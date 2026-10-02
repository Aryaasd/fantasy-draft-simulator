/**
 * Logic check for the mock draft engine.
 * Run: node --experimental-strip-types scripts/check-draft.ts
 *
 * Snake math drives pick ownership, roster construction, and prefetch timing,
 * so an off-by-one on even rounds would silently mis-assign every other round.
 *
 * Hits two live APIs — Sleeper for the player pool, Fantasy Football Calculator
 * for ADP — because the failure this is really guarding against is the join
 * between them breaking when a name changes upstream.
 */
import {
  detectRun,
  isMyPick,
  nextPickForMe,
  overallForRound,
  roundAndPick,
  rosterNeeds,
  searchPool,
  slotForOverall,
  unfilledSlots,
} from '../lib/draft.ts'
import { fetchPlayerPool, type PoolPlayer } from '../lib/players.ts'
import { fetchAdpBoard } from '../lib/adp.ts'
import { simulateAdpPick, survivalOdds } from '../lib/mock.ts'
import { readTheRoom, tradeFits } from '../lib/room.ts'
import { assignLineup } from '../lib/lineup.ts'
import { analyzeDraft, curve } from '../lib/analysis.ts'
import { suggestPicks } from '../lib/suggest.ts'
import { draftPlan } from '../lib/plan.ts'
import { availabilityAt } from '../lib/mock.ts'
import { describeInjury, flaggedPlayers, rosterHealthLine } from '../lib/injury.ts'

let failures = 0
function board_entries_all_within_unit(entries: { adp: number; stdev: number }[]): boolean {
  for (const e of entries) {
    for (const n of [1, 2, 5, 20, 60, 150, 300]) {
      const a = availabilityAt(e as never, n)
      if (!(a >= 0 && a <= 1) || Number.isNaN(a)) return false
    }
  }
  return true
}
const LADDER_ORDER = ['D', 'C-', 'C', 'C+', 'B-', 'B', 'B+', 'A-', 'A', 'A+']
const LADDER_IDX = (g: string) => LADDER_ORDER.indexOf(g)
function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a === e) {
    console.log(`  ok   ${label}`)
  } else {
    failures++
    console.log(`  FAIL ${label}\n         expected ${e}\n         actual   ${a}`)
  }
}

const TEAMS = 18

console.log('\nsnake order (18 teams)')
// Odd rounds run forward, even rounds run back.
check('pos 5, R1', overallForRound(1, 5, TEAMS), 5)
check('pos 5, R2', overallForRound(2, 5, TEAMS), 32)
check('pos 5, R3', overallForRound(3, 5, TEAMS), 41)
check('pos 1, R2 (last of round)', overallForRound(2, 1, TEAMS), 36)
check('pos 18, R1', overallForRound(18 - 17, 18, TEAMS), 18)
check('pos 18, R2 (turn, back-to-back)', overallForRound(2, 18, TEAMS), 19)

console.log('\ngap between turns = 2*(teams-pos)+1 on the odd->even boundary')
check('pos 5 gap', overallForRound(2, 5, TEAMS) - overallForRound(1, 5, TEAMS), 27)
check('pos 1 gap', overallForRound(2, 1, TEAMS) - overallForRound(1, 1, TEAMS), 35)
check('pos 18 gap', overallForRound(2, 18, TEAMS) - overallForRound(1, 18, TEAMS), 1)

console.log('\nroundAndPick round-trips')
check('overall 32', roundAndPick(32, TEAMS), { round: 2, pick: 14 })
check('overall 1', roundAndPick(1, TEAMS), { round: 1, pick: 1 })
check('overall 18', roundAndPick(18, TEAMS), { round: 1, pick: 18 })
check('overall 19', roundAndPick(19, TEAMS), { round: 2, pick: 1 })

console.log('\nownership')
check('32 belongs to pos 5', isMyPick(32, 5, TEAMS), true)
check('31 does not', isMyPick(31, 5, TEAMS), false)
check('5 belongs to pos 5', isMyPick(5, 5, TEAMS), true)
// Every overall pick must belong to exactly one position.
let ownershipOk = true
for (let o = 1; o <= TEAMS * 4; o++) {
  const owners = []
  for (let p = 1; p <= TEAMS; p++) if (isMyPick(o, p, TEAMS)) owners.push(p)
  if (owners.length !== 1) ownershipOk = false
}
check('each of first 4 rounds maps to exactly one owner', ownershipOk, true)

console.log('\nnextPickForMe')
check('at 1, pos 5', nextPickForMe(1, 5, TEAMS, 20), { overall: 5, round: 1 })
check('at 6, pos 5 -> next is R2', nextPickForMe(6, 5, TEAMS, 20), {
  overall: 32,
  round: 2,
})
check('on the clock returns current', nextPickForMe(32, 5, TEAMS, 20), {
  overall: 32,
  round: 2,
})

console.log('\nroster needs (FLEX absorbs RB/WR/TE surplus)')
const SLOTS = { QB: 1, RB: 2, WR: 2, TE: 1, FLEX: 1, DEF: 1, K: 1 }
const mk = (pos: PoolPlayer['pos'], i: number): PoolPlayer => ({
  id: `${pos}${i}`,
  name: `${pos} ${i}`,
  pos,
  team: 'XXX',
  rank: i,
  injury: null,
  search: `${pos}${i}`,
  tokens: [pos.toLowerCase(), String(i)],
})

// FLEX is appended after the dedicated slots, so it sorts last.
check('empty roster needs everything', unfilledSlots(rosterNeeds(SLOTS, [])), [
  'QB',
  'RB',
  'WR',
  'TE',
  'DEF',
  'K',
  'FLEX',
])
check(
  '3 RB fills RB,RB and FLEX',
  rosterNeeds(SLOTS, [mk('RB', 1), mk('RB', 2), mk('RB', 3)]).find(
    (s) => s.slot === 'FLEX',
  ),
  { slot: 'FLEX', need: 1, filled: 1 },
)
check(
  '2 RB does not fill FLEX',
  rosterNeeds(SLOTS, [mk('RB', 1), mk('RB', 2)]).find((s) => s.slot === 'FLEX'),
  { slot: 'FLEX', need: 1, filled: 0 },
)
check(
  'QB surplus does NOT fill FLEX',
  rosterNeeds(SLOTS, [mk('QB', 1), mk('QB', 2)]).find((s) => s.slot === 'FLEX'),
  { slot: 'FLEX', need: 1, filled: 0 },
)

console.log('\nlineup — the starting eleven')
{
  const lineupOf = (players: PoolPlayer[]) =>
    assignLineup(
      players.map((p, i) => ({ player: p, round: i + 1, order: p.rank })),
      SLOTS,
    )

  const empty = lineupOf([])
  // Both the ordering and the labelling in one assertion: conventional lineup
  // order regardless of how roster_slots is stored, and a number only where a
  // slot actually repeats — nobody writes "QB1" when there is one quarterback.
  check('slots render in conventional order, numbered only when repeated', empty.starters.map((s) => s.label), [
    'QB', 'RB1', 'RB2', 'WR1', 'WR2', 'TE', 'FLEX', 'DEF', 'K',
  ])
  check('an empty roster still renders every slot', empty.starters.length, 9)
  check('...every one of them empty rather than absent', empty.starters.every((s) => s.entry === null), true)

  // The whole reason for this view: a hole is a visible empty row, not a chip.
  check('an unfilled TE is an empty row', lineupOf([mk('RB', 1)]).starters.find((s) => s.slot === 'TE')?.entry, null)

  // Draft order must not decide the depth chart — the market does.
  check(
    'RB1 is the better-ranked back whatever order they were drafted in',
    lineupOf([mk('RB', 5), mk('RB', 2)]).starters.find((s) => s.label === 'RB1')?.entry?.player.name,
    'RB 2',
  )

  const three = lineupOf([mk('RB', 1), mk('RB', 2), mk('RB', 3)])
  check('a 3rd RB starts at FLEX', three.starters.find((s) => s.slot === 'FLEX')?.entry?.player.name, 'RB 3')
  check('...and does not appear on the bench', three.bench.length, 0)

  // FLEX pools RB/WR/TE and re-sorts, so it takes the best spare player rather
  // than the best spare running back.
  const mix = lineupOf([mk('RB', 1), mk('RB', 2), mk('RB', 9), mk('WR', 3), mk('WR', 4), mk('WR', 5)])
  check('FLEX takes the best spare across positions', mix.starters.find((s) => s.slot === 'FLEX')?.entry?.player.name, 'WR 5')

  const deep = lineupOf([mk('RB', 1), mk('RB', 2), mk('RB', 3), mk('RB', 4), mk('RB', 5)])
  check('the bench keeps draft order', deep.bench.map((e) => e.player.name), ['RB 4', 'RB 5'])

  // No player may be both a starter and a bench player, at any roster shape.
  // A double-count would inflate the roster on screen and, downstream, in the
  // analyzer's positional depth ranking.
  const POS: PoolPlayer['pos'][] = ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']
  let agree = true
  let leaks = 0
  let counterexample = ''
  for (let trial = 0; trial < 400; trial++) {
    const players: PoolPlayer[] = []
    for (let i = 0; i < trial % 16; i++) players.push(mk(POS[(trial * 7 + i * 3) % POS.length], i + 1))
    const { starters, bench } = lineupOf(players)

    if (starters.filter((s) => s.entry).length + bench.length !== players.length) leaks++

    // THE cross-check. If these disagree, the needs chip reports FLEX filled
    // while the lineup shows an empty FLEX row — a contradiction sitting on
    // screen in the one panel whose entire job is to be believed.
    for (const s of rosterNeeds(SLOTS, players)) {
      const filled = starters.filter((x) => x.slot === s.slot && x.entry).length
      if (filled !== s.filled && !counterexample) {
        agree = false
        counterexample = `${s.slot}: needs=${s.filled} lineup=${filled} roster=[${players.map((p) => p.pos).join(',')}]`
      }
    }
  }
  check('lineup fills exactly the slots rosterNeeds reports, across 400 rosters', agree, true)
  if (counterexample) console.log(`         counterexample ${counterexample}`)
  check('every drafted player lands in exactly one of starters or bench', leaks, 0)
}

console.log('\nslot ordering survives a jsonb round-trip')
{
  /**
   * Exactly how Postgres hands `roster_slots` back: jsonb sorts keys by length
   * then bytewise, so a league seeded {QB,RB,WR,TE,FLEX,DEF,K} reads back with
   * the kicker first. Every needs chip in the app rendered in this order on
   * real leagues while the design preview — which passes an object literal —
   * looked perfect.
   */
  const asJsonb = { K: 1, QB: 1, RB: 2, TE: 1, WR: 2, DEF: 1, FLEX: 1 }
  check('the column really does come back scrambled', Object.keys(asJsonb), [
    'K', 'QB', 'RB', 'TE', 'WR', 'DEF', 'FLEX',
  ])
  check('needs are reported in lineup order regardless', rosterNeeds(asJsonb, []).map((x) => x.slot), [
    'QB', 'RB', 'WR', 'TE', 'DEF', 'K', 'FLEX',
  ])
  check('...and so is the unfilled list the report reads out', unfilledSlots(rosterNeeds(asJsonb, [])), [
    'QB', 'RB', 'WR', 'TE', 'DEF', 'K', 'FLEX',
  ])
  // The lineup must agree with the chips beside it whichever order it was given.
  check('the lineup is unmoved by column order',
    assignLineup([], asJsonb).starters.map((x) => x.label),
    assignLineup([], SLOTS).starters.map((x) => x.label))
  check('...and is still conventional',
    assignLineup([], asJsonb).starters.map((x) => x.label),
    ['QB', 'RB1', 'RB2', 'WR1', 'WR2', 'TE', 'FLEX', 'DEF', 'K'])
  // A league with an unusual slot must not lose it.
  const odd = { K: 1, QB: 1, RB: 2, WR: 2, TE: 1, DEF: 1, FLEX: 1, IDP: 1 }
  check('an unrecognised slot is kept, not dropped',
    rosterNeeds(odd, []).some((x) => x.slot === 'IDP'), true)
}

console.log('\npositional runs')
const rbRun = [...Array(5)].map((_, i) => mk('RB', i))
check('5 straight RB is a run', detectRun(rbRun)?.pos, 'RB')
check('3 RB is not', detectRun([mk('RB', 1), mk('RB', 2), mk('RB', 3)]), null)
check(
  'K/DEF never count as a run',
  detectRun([...Array(6)].map((_, i) => mk('K', i))),
  null,
)

console.log('\nslotForOverall — inverse of overallForRound')
// This is NOT roundAndPick().pick: on even rounds the round-position and the
// draft slot run in opposite directions. Getting it wrong hands every
// simulated opponent the wrong roster on half the rounds.
check('overall 5 -> slot 5 (odd round)', slotForOverall(5, TEAMS), 5)
check('overall 19 -> slot 18 (even round)', slotForOverall(19, TEAMS), 18)
check('overall 32 -> slot 5 (even round)', slotForOverall(32, TEAMS), 5)
check('overall 36 -> slot 1 (even round)', slotForOverall(36, TEAMS), 1)
let inverseOk = true
for (let r = 1; r <= 6; r++) {
  for (let p = 1; p <= TEAMS; p++) {
    if (slotForOverall(overallForRound(r, p, TEAMS), TEAMS) !== p) inverseOk = false
  }
}
check('round-trips against overallForRound for 6 rounds', inverseOk, true)

console.log('\nthe room — per-team shape')
// Every pick must land in exactly one team's roster, or somebody's shape is a
// fiction and the trade advice built on it is worse than nothing.
{
  const roomPicks = [...Array(36)].map((_, i) => ({ playerId: `p${i + 1}`, overall: i + 1 }))
  const posCycle: PoolPlayer['pos'][] = ['RB', 'WR', 'QB', 'TE']
  const room = readTheRoom({
    picks: roomPicks,
    teams: TEAMS,
    slots: SLOTS,
    lookup: (id) => {
      const n = Number(id.slice(1))
      return { id, name: `Player ${n}`, pos: posCycle[n % posCycle.length] }
    },
    mySlot: 5,
  })
  check('one entry per team', room.length, TEAMS)
  check(
    'every logged pick lands in exactly one roster',
    room.reduce((sum, t) => sum + t.players.length, 0),
    roomPicks.length,
  )
  check('two rounds of 18 gives every team two players', room.every((t) => t.players.length === 2), true)
  check('exactly one team is me', room.filter((t) => t.isMe).length, 1)
  check('my team is the one at my slot', room.find((t) => t.isMe)?.slot, 5)
  check('teams with no name fall back to a slot label', room[0].label, 'Team 1')

  // An unresolvable player is dropped, not faked into a roster hole.
  const withGap = readTheRoom({
    picks: [{ playerId: 'ghost', overall: 1 }],
    teams: TEAMS,
    slots: SLOTS,
    lookup: () => undefined,
  })
  check('an unresolvable pick is dropped, not invented', withGap[0].players.length, 0)

  // Member names replace slot labels when the league knows them (v2 uses this
  // on the live board, where draft_position maps a slot to a real person).
  const named = readTheRoom({
    picks: [],
    teams: 3,
    slots: SLOTS,
    labels: new Map([[2, 'McCall']]),
  lookup: () => undefined,
  })
  check('a known slot shows the member name', named[1].label, 'McCall')
  check('an unknown slot still falls back', named[0].label, 'Team 1')
}

console.log('\nthe room — surplus and holes')
{
  const mk3 = (pos: PoolPlayer['pos'], i: number) => ({ id: `${pos}${i}`, name: `${pos} ${i}`, pos })
  // Every player has to land on the SAME team, which means walking slot 1's
  // own picks — `i * teams + 1` looks right and isn't: even rounds run
  // backwards, so overall 19 belongs to slot 18, not slot 1.
  const shapeOf = (players: { id: string; name: string; pos: PoolPlayer['pos'] }[]) =>
    readTheRoom({
      picks: players.map((p, i) => ({ playerId: p.id, overall: overallForRound(i + 1, 1, 18) })),
      teams: 18,
      slots: SLOTS,
      lookup: (id) => players.find((p) => p.id === id),
    })[0]

  // SLOTS starts 2 RB + 1 FLEX, so the 3rd back is a flex starter, not spare.
  check('a 3rd RB fills FLEX and is not surplus', shapeOf([mk3('RB', 1), mk3('RB', 2), mk3('RB', 3)]).surplus, [])
  check('a 4th RB is surplus', shapeOf([mk3('RB', 1), mk3('RB', 2), mk3('RB', 3), mk3('RB', 4)]).surplus, ['RB'])
  // QB can't fill FLEX, so the 2nd one is spare immediately.
  check('a 2nd QB is surplus straight away', shapeOf([mk3('QB', 1), mk3('QB', 2)]).surplus, ['QB'])
  check('an empty roster has no surplus', shapeOf([]).surplus, [])
  // Ordered by the league's roster_slots, which is where the needs come from.
  check('an empty roster holes at every real position', shapeOf([]).holes, ['QB', 'RB', 'WR', 'TE', 'DEF', 'K'])
  check('FLEX is never reported as a positional hole', shapeOf([]).holes.includes('FLEX' as never), false)
}

console.log('\nthe room — corrupt board state')
// The board rehydrates from localStorage, which anyone can edit and any
// half-finished write can truncate. None of this should be trusted.
{
  const one = (id: string) => ({ id, name: `N${id}`, pos: 'RB' as PoolPlayer['pos'] })
  const build = (picks: { playerId: string; overall: number }[], teams = 4) =>
    readTheRoom({ picks, teams, slots: SLOTS, lookup: one })
  const total = (r: ReturnType<typeof build>) => r.reduce((s, t2) => s + t2.players.length, 0)

  check('teams = 0 yields no room', build([{ playerId: 'a', overall: 1 }], 0).length, 0)
  check('negative teams yields no room', build([], -5).length, 0)
  check('fractional teams yields no room', readTheRoom({ picks: [], teams: 4.5, slots: SLOTS, lookup: one }).length, 0)
  // A negative or fractional pick still resolves through the snake maths — to
  // the WRONG slot — so it has to be rejected rather than trusted.
  check('overall 0 is rejected', total(build([{ playerId: 'a', overall: 0 }])), 0)
  check('negative overall is rejected', total(build([{ playerId: 'a', overall: -3 }])), 0)
  check('fractional overall is rejected', total(build([{ playerId: 'a', overall: 2.7 }])), 0)
  check('NaN overall is rejected', total(build([{ playerId: 'a', overall: NaN }])), 0)
  // The same player on two rosters would inflate both teams' surplus and
  // recommend a trade for somebody who does not exist twice.
  check(
    'a duplicated pick is counted once',
    total(build([{ playerId: 'a', overall: 1 }, { playerId: 'a', overall: 2 }])),
    1,
  )
  check(
    'the duplicate keeps its first, real owner',
    build([{ playerId: 'a', overall: 1 }, { playerId: 'a', overall: 2 }])
      .findIndex((t2) => t2.players.length > 0) + 1,
    1,
  )
  check('a valid board is untouched by all of that', total(build([
    { playerId: 'a', overall: 1 },
    { playerId: 'b', overall: 2 },
    { playerId: 'c', overall: 3 },
  ])), 3)
}

console.log('\nthe room — trade fit')
{
  // Constructed complement: I am WR-heavy and RB-poor, slot 12 is the mirror.
  const roster: Record<number, PoolPlayer['pos'][]> = {
    5: ['WR', 'WR', 'WR', 'WR', 'WR', 'QB'],
    12: ['RB', 'RB', 'RB', 'RB', 'RB', 'QB'],
    3: ['RB', 'WR', 'QB', 'TE', 'K', 'DEF'],
  }
  const players: { id: string; name: string; pos: PoolPlayer['pos'] }[] = []
  const picks: { playerId: string; overall: number }[] = []
  for (const [slotStr, list] of Object.entries(roster)) {
    const slot = Number(slotStr)
    list.forEach((pos, i) => {
      const id = `t${slot}-${i}`
      players.push({ id, name: id, pos })
      picks.push({ playerId: id, overall: overallForRound(i + 1, slot, TEAMS) })
    })
  }
  const room = readTheRoom({
    picks,
    teams: TEAMS,
    slots: SLOTS,
    lookup: (id) => players.find((p) => p.id === id),
    mySlot: 5,
  })
  const fits = tradeFits(room, 5)

  check('the mirror image ranks first', fits[0].slot, 12)
  check('they want my spare receivers', fits[0].theyWant, ['WR'])
  check('I want their spare backs', fits[0].iWant, ['RB'])
  check('a two-way fit outscores the rest', fits[0].score > fits[1].score, true)
  check('I am never my own trade partner', fits.some((f) => f.slot === 5), false)
  check('every other team is still listed', fits.length, TEAMS - 1)
  check(
    'fits are sorted by score, descending',
    fits.every((f, i, a) => i === 0 || a[i - 1].score >= f.score),
    true,
  )
  check('an unknown slot yields no fits', tradeFits(room, 999).length, 0)

  // The room is a pure function of the picks, so undoing back to a point must
  // equal never having gone past it — this is what makes the mock's undo safe.
  const truncated = picks.slice(0, 8)
  const a = readTheRoom({ picks: truncated, teams: TEAMS, slots: SLOTS, lookup: (id) => players.find((p) => p.id === id), mySlot: 5 })
  const b = readTheRoom({ picks: [...truncated], teams: TEAMS, slots: SLOTS, lookup: (id) => players.find((p) => p.id === id), mySlot: 5 })
  check('the room is stable under undo', JSON.stringify(a), JSON.stringify(b))
}

console.log('\ninjury status — decoding')
check('no flag reads as healthy', describeInjury(null), null)
check('an empty string is not a flag', describeInjury('   '), null)
check('IR is out', describeInjury('IR')?.severity, 'out')
check('PUP is out', describeInjury('PUP')?.severity, 'out')
check('Questionable is its own tier, not danger', describeInjury('Questionable')?.severity, 'questionable')
check('Doubtful sits between them', describeInjury('Doubtful')?.severity, 'doubtful')
// A suspension is not a health problem, and saying so changes whether he is
// worth a late pick — he comes back at full strength.
check('a suspension is flagged as non-medical', describeInjury('Sus')?.nonMedical, true)
check('a holdout is flagged as non-medical', describeInjury('DNR')?.nonMedical, true)
check('an actual injury is not', describeInjury('IR')?.nonMedical, false)
check('codes are expanded out of jargon', describeInjury('PUP')?.label, 'Physically unable to perform')
check('punctuation variants collapse', describeInjury('IR-R')?.label, describeInjury('IRR')?.label)
check('lowercase still resolves', describeInjury('questionable')?.severity, 'questionable')
// An unknown code must survive rather than vanish — hiding a status we cannot
// explain is the one genuinely unsafe way to fail here.
check('an unknown code is surfaced, not dropped', describeInjury('ZZZ')?.severity, 'unknown')
check('an unknown code keeps its raw text', describeInjury('ZZZ')?.label, 'ZZZ')
check('the raw code is always preserved', describeInjury('Questionable')?.code, 'Questionable')
check('every known code explains itself', Object.values(['IR','PUP','NFI','OUT','Doubtful','Questionable','Sus','DNR','NA']).every((c) => (describeInjury(c)?.meaning.length ?? 0) > 20), true)

console.log('\ninjury status — malformed upstream data')
check('a non-string status is ignored', describeInjury(123 as never), null)
check('whitespace collapses', describeInjury('IR\n\n  ')?.code, 'IR')
// A pill has to fit on a row; an unbounded upstream string would stretch it
// across the board.
check('an absurd code is truncated for display', (describeInjury('X'.repeat(200))?.label.length ?? 0) <= 14, true)
check('a newline never reaches the pill', /\n/.test(describeInjury('IR\nDROP')?.label ?? ''), false)
check('a short unknown code is left intact', describeInjury('ZZZ')?.label, 'ZZZ')
// The name comes from the player pool across a network boundary.
check(
  'a missing name never renders as "undefined"',
  /undefined/.test(rosterHealthLine(flaggedPlayers([{ name: undefined as never, injury: 'IR' }])) ?? ''),
  false,
)
check(
  'a missing name still reports the flag',
  rosterHealthLine(flaggedPlayers([{ name: undefined as never, injury: 'IR' }]))?.includes('injured reserve'),
  true,
)
check('sorting survives a missing name', flaggedPlayers([
  { name: undefined as never, injury: 'IR' },
  { name: 'Real Player', injury: 'Questionable' },
]).length, 2)

console.log('\ninjury status — roster roll-up')
{
  const squad = [
    { name: 'Healthy Harry', injury: null },
    { name: 'Questionable Quinn', injury: 'Questionable' },
    { name: 'Reserve Ray', injury: 'IR' },
    { name: 'Doubtful Dana', injury: 'Doubtful' },
  ]
  const flagged = flaggedPlayers(squad)
  check('healthy players are left out', flagged.length, 3)
  check('worst first', flagged.map((f) => f.player.name), [
    'Reserve Ray',
    'Doubtful Dana',
    'Questionable Quinn',
  ])
  check('a clean roster produces no line', rosterHealthLine([]), null)
  check(
    'one flag reads as singular',
    rosterHealthLine(flaggedPlayers([{ name: 'Reserve Ray', injury: 'IR' }])),
    'One player on your roster is flagged: Reserve Ray (injured reserve).',
  )
  check('several read as plural', rosterHealthLine(flagged)?.startsWith('3 players'), true)
}

console.log('\nADP board (live market data)')
// Both live sources are pulled here so the network sections read together.
const pool = await fetchPlayerPool()
console.log(`  (pool: ${pool.length} players)`)
const adpBoard = await fetchAdpBoard('ppr', pool)
const observed = adpBoard.entries.filter((e) => e.observed)

console.log(
  `  (${adpBoard.meta.totalDrafts.toLocaleString()} drafts, ` +
    `${adpBoard.meta.startDate} -> ${adpBoard.meta.endDate})`,
)

// The matcher is the fragile seam: FFC and Sleeper disagree about suffixes,
// accents, and how to name a defense. Every unmatched row is a player who
// silently disappears from the draft, so this asserts the whole list lands.
check(
  'every ADP row matched a Sleeper player',
  observed.length,
  adpBoard.meta.observedCount,
)
/**
 * The old assertion here was `observed.length > 200`, which quietly encoded
 * "it is August". Fantasy Football Calculator samples real mock drafts, and
 * nobody mock-drafts in October — the same call that saw ~8,000 drafts
 * preseason sees barely a hundred mid-season, with under 30 players carrying
 * observed ADP. That is the data source behaving correctly, not a failure.
 *
 * What actually has to hold year-round is that the board can finish a draft:
 * every position a lineup requires must be present in usable numbers.
 */
{
  const byPos = new Map<string, number>()
  for (const e of adpBoard.entries) byPos.set(e.player.pos, (byPos.get(e.player.pos) ?? 0) + 1)
  for (const pos of ['QB', 'RB', 'WR', 'TE', 'K', 'DEF']) {
    check(`the board carries enough ${pos} to fill any league`, (byPos.get(pos) ?? 0) >= 20, true)
  }
  console.log(`  info observed ADP on ${observed.length} players (seasonal — rich in preseason, thin after)`)
}
check(
  'board is sorted by ADP',
  adpBoard.entries.every((e, i, a) => i === 0 || a[i - 1].adp <= e.adp),
  true,
)
check(
  'the ranked tail sorts after every observed player',
  adpBoard.entries.findIndex((e) => !e.observed) >= observed.length,
  true,
)
check(
  'no player appears twice',
  new Set(adpBoard.entries.map((e) => e.player.id)).size,
  adpBoard.entries.length,
)
check(
  'stdev is floored so nobody is treated as a certainty',
  adpBoard.entries.every((e) => e.stdev >= 3),
  true,
)

console.log('\nsurvival odds')
const early = adpBoard.entries[0]
check('a player is certain to be there at the current pick', survivalOdds(early, 10, 10), 1)
check(
  'odds fall the further out you look',
  survivalOdds(early, 1, 12) > survivalOdds(early, 1, 30),
  true,
)
check(
  'odds stay inside [0,1]',
  adpBoard.entries.slice(0, 120).every((e) => {
    const o = survivalOdds(e, 40, 70)
    return o >= 0 && o <= 1
  }),
  true,
)
// The conditioning is the whole point: a first-rounder still on the board at 40
// is visibly sliding, and unconditional odds would call him unreachable at the
// exact moment he is the easiest player in the draft to get.
check(
  'a sliding player reads as gettable, not impossible',
  survivalOdds(early, 40, 45) > 0.4,
  true,
)

console.log('\nADP opponent simulation')
const simOpts = { slots: SLOTS, round: 3, totalRounds: 15 }
check(
  'never drafts K/DEF outside the last two rounds',
  [...Array(40)]
    .map(() => simulateAdpPick(adpBoard.entries, new Set(), [], simOpts)?.player.pos)
    .some((p) => p === 'K' || p === 'DEF'),
  false,
)
check(
  'respects the position cap',
  simulateAdpPick(
    adpBoard.entries,
    new Set(),
    [{ pos: 'QB' as const }, { pos: 'QB' as const }],
    simOpts,
  )?.player.pos === 'QB',
  false,
)
check(
  'varies between runs',
  new Set(
    [...Array(25)].map(
      () => simulateAdpPick(adpBoard.entries, new Set(), [], simOpts)?.player.id,
    ),
  ).size > 1,
  true,
)
check(
  'returns null when the board is exhausted',
  simulateAdpPick(
    adpBoard.entries,
    new Set(adpBoard.entries.map((e) => e.player.id)),
    [],
    simOpts,
  ),
  null,
)

// The integration check. An 18-team, 15-round draft is 270 picks — deeper than
// ADP covers — so this is also what proves the ranked tail carries the last
// third rather than the board running dry mid-draft.
console.log('\nfull 18-team draft')
const DEEP_TEAMS = 18
const DEEP_ROUNDS = 15
const deepPicks: { id: string; pos: string; overall: number }[] = []
const deepTaken = new Set<string>()
for (let overall = 1; overall <= DEEP_TEAMS * DEEP_ROUNDS; overall++) {
  const owner = slotForOverall(overall, DEEP_TEAMS)
  const roster = deepPicks
    .filter((p) => slotForOverall(p.overall, DEEP_TEAMS) === owner)
    .map((p) => ({ pos: p.pos as PoolPlayer['pos'] }))
  const choice = simulateAdpPick(adpBoard.entries, deepTaken, roster, {
    slots: SLOTS,
    round: roundAndPick(overall, DEEP_TEAMS).round,
    totalRounds: DEEP_ROUNDS,
  })
  if (!choice) break
  deepTaken.add(choice.player.id)
  deepPicks.push({ id: choice.player.id, pos: choice.player.pos, overall })
}
check('fills all 270 picks', deepPicks.length, DEEP_TEAMS * DEEP_ROUNDS)
check('no player drafted twice', new Set(deepPicks.map((p) => p.id)).size, deepPicks.length)

// Kickers and defenses can only be judged across a whole draft: asked in
// isolation with an empty board, no sane model takes a kicker over the best
// player alive, so a single-pick assertion tests nothing. What matters is that
// by the end every team has exactly one of each, and none of them went early.
check(
  'every team ends with exactly one kicker and one defense',
  [...Array(DEEP_TEAMS)].every((_, i) => {
    const mine = deepPicks.filter((p) => slotForOverall(p.overall, DEEP_TEAMS) === i + 1)
    return (
      mine.filter((p) => p.pos === 'K').length === 1 &&
      mine.filter((p) => p.pos === 'DEF').length === 1
    )
  }),
  true,
)
check(
  'no kicker or defense before the last two rounds',
  deepPicks
    .filter((p) => p.pos === 'K' || p.pos === 'DEF')
    .every((p) => roundAndPick(p.overall, DEEP_TEAMS).round > DEEP_ROUNDS - 2),
  true,
)
// A draft nobody would recognise is a draft nobody learns from.
const deepCounts = new Map<string, number>()
for (const p of deepPicks) deepCounts.set(p.pos, (deepCounts.get(p.pos) ?? 0) + 1)
check(
  'receivers and backs dominate the board',
  (deepCounts.get('WR') ?? 0) + (deepCounts.get('RB') ?? 0) > deepPicks.length / 2,
  true,
)
console.log(
  `  info positions: ${[...deepCounts]
    .sort((a, b) => b[1] - a[1])
    .map(([p, n]) => `${p} ${n}`)
    .join(', ')}`,
)
const firstRound = deepPicks.slice(0, DEEP_TEAMS).map((p) => p.pos)
check(
  'round 1 is all skill positions',
  firstRound.every((p) => p === 'RB' || p === 'WR' || p === 'TE' || p === 'QB'),
  true,
)
console.log(
  `  info round 1: ${deepPicks
    .slice(0, 5)
    .map((p) => adpBoard.entries.find((e) => e.player.id === p.id)?.player.name)
    .join(', ')}...`,
)

console.log('\ntype-ahead against the live Sleeper pool')
// Uses the real mapper so this also covers team defenses, which arrive with no
// full_name and would otherwise produce an undefined search key.
check(
  'every entry has a usable search key',
  pool.filter((p) => !p.search).length,
  0,
)
// Every status the live pool actually carries must decode to something we can
// put in front of a beginner. A new Sleeper code would otherwise surface as a
// bare acronym on the board, which is the exact failure lib/injury.ts exists to
// prevent — so this fails loudly instead.
{
  const codes = [...new Set(pool.map((p) => p.injury).filter(Boolean))] as string[]
  const undecoded = codes.filter((c) => describeInjury(c)?.severity === 'unknown')
  console.log(`  info live injury codes: ${codes.sort().join(', ') || '(none)'}`)
  check('every live injury code has a plain-English explanation', undecoded, [])
  check(
    'flagged players are a minority of the pool',
    pool.filter((p) => p.injury).length < pool.length / 2,
    true,
  )
}

const def = pool.find((p) => p.pos === 'DEF')
check('team defenses get a real name', !!def && /\w+ \w+/.test(def.name), true)

const none = new Set<string>()
check('"bij" -> Bijan Robinson', searchPool(pool, 'bij', none)[0]?.name, 'Bijan Robinson')
check('"mccaff" -> CMC', searchPool(pool, 'mccaff', none)[0]?.name, 'Christian McCaffrey')
check(
  '"jamarr" matches through the apostrophe',
  searchPool(pool, 'jamarr', none)[0]?.name,
  "Ja'Marr Chase",
)
check(
  'every entry has name tokens',
  pool.filter((p) => !p.tokens?.length).length,
  0,
)
// Surnames are what people actually type. Before tokens existed this returned
// two rank-300 wideouts named Jeff, because they matched at offset zero.
check(
  '"jeff" -> Justin Jefferson, not someone first-named Jeff',
  searchPool(pool, 'jeff', none)[0]?.name,
  'Justin Jefferson',
)
check(
  '"chase" matches the surname',
  searchPool(pool, 'chase', none)[0]?.name,
  "Ja'Marr Chase",
)
// A query spanning the gap between names matches no single token, so this only
// works if the whole concatenated key is still consulted.
check(
  'multi-word queries still resolve',
  searchPool(pool, 'justin jeff', none)[0]?.name,
  'Justin Jefferson',
)

const top = searchPool(pool, 'jo', none)[0]
console.log(`  info "jo" -> ${top?.name} (name-start + rank ordering)`)

const takenCmc = new Set(
  pool.filter((p) => p.name === 'Christian McCaffrey').map((p) => p.id),
)
check(
  'taken players are excluded',
  searchPool(pool, 'mccaff', takenCmc).some((p) => p.name === 'Christian McCaffrey'),
  false,
)

console.log('\ndraft analyzer — the grade')
{
  check('the best team in the field gets the top grade', curve(1, 18), 'A+')
  check('last place floors at D, never F', curve(18, 18), 'D')
  check('mid-table is a B', curve(9, 18), 'B')
  // Monotonic: finishing higher can never grade worse.
  let mono = true
  for (let r = 2; r <= 18; r++) {
    if (LADDER_IDX(curve(r - 1, 18)) < LADDER_IDX(curve(r, 18))) mono = false
  }
  check('grade never improves as you finish lower', mono, true)

  // A synthetic board: 400 players, ADP == board position, first 200 observed.
  // Hand-built so every expected answer below is true by construction rather
  // than by whatever the live market happens to look like today.
  const synth = {
    entries: Array.from({ length: 400 }, (_, i) => ({
      player: {
        id: `p${i + 1}`,
        name: `Player ${i + 1}`,
        pos: (['RB', 'WR', 'QB', 'TE', 'K', 'DEF'] as const)[i % 6],
        team: 'XXX',
        injury: null,
      },
      adp: i + 1,
      stdev: 8,
      timesDrafted: 10,
      observed: i < 200,
    })),
    meta: { format: 'ppr', totalDrafts: 1, startDate: '', endDate: '', observedCount: 200 },
  }
  const TEAMS2 = 4
  const ROUNDS2 = 9

  // Everyone takes the top of the board except slot 1, who deliberately
  // reaches at their first pick and is handed a slider at their second.
  const straight: { playerId: string; overall: number }[] = []
  {
    const taken = new Set<string>()
    for (let o = 1; o <= TEAMS2 * ROUNDS2; o++) {
      let pick
      if (o === 1) pick = synth.entries[30]        // reach: board position 31 at pick 1
      else if (o === 8) pick = synth.entries[1]    // slider: ADP 2 at pick 8
      else pick = synth.entries.find((e) => !taken.has(e.player.id))!
      taken.add(pick.player.id)
      straight.push({ playerId: pick.player.id, overall: o })
    }
  }

  const r1 = analyzeDraft({
    picks: straight, board: synth, teams: TEAMS2, slot: 1, rounds: ROUNDS2, slots: SLOTS,
  })
  check('the deliberate reach is reported as the reach', r1.reach?.player.name, 'Player 31')
  check('...with the right size', r1.reach?.slide, 1 - 31)
  check('the slider is reported as the steal', r1.steal?.player.name, 'Player 2')
  check('...with the right size', r1.steal?.slide, 8 - 2)

  // Past the observed market ADP is a synthetic counter, so a "steal" down
  // there is arithmetic on an array index, not a claim about a market.
  const tailOnly = Array.from({ length: TEAMS2 * ROUNDS2 }, (_, i) => ({
    playerId: synth.entries[250 + i].player.id,
    overall: i + 1,
  }))
  const rTail = analyzeDraft({
    picks: tailOnly, board: synth, teams: TEAMS2, slot: 1, rounds: ROUNDS2, slots: SLOTS,
  })
  check('an unobserved pick is never called a steal', rTail.steal, null)
  check('...nor a reach', rTail.reach, null)

  // Kickers and defenses go late by convention, not because the market moved.
  // Left in, every one of them in a deep league reads as an enormous steal —
  // a defense at #248 was reported as having "slid 115 picks to you".
  const defs = synth.entries.filter((e) => e.player.pos === 'DEF' && e.observed)
  const lateDef = defs.map((e, i) => ({ playerId: e.player.id, overall: i + 1 }))
  const rDef = analyzeDraft({
    picks: lateDef, board: synth, teams: TEAMS2, slot: 1, rounds: ROUNDS2, slots: SLOTS,
  })
  check('a defense is never reported as a steal', rDef.steal, null)

  // Consensus past the last pick of the draft is not a reach — the market has
  // no opinion on WHEN he goes, only that a league this size doesn't take him.
  // Uncapped, a real card's biggest reach came out as a round-12 backup QB at
  // -100, burying the round-4 reach that actually cost a starter.
  // Index 192 is an RB on this board; 190 is a kicker, which is excluded a step
  // earlier for a different reason and would prove nothing here.
  const deepGuy = synth.entries[192]   // consensus #193, past 4 x 9 = 36 picks
  const beyond = analyzeDraft({
    // Overall 8 is slot 1's round-2 pick in a 4-team snake. Overall 20 belongs
    // to slot 4, so it would simply not be one of my picks at all.
    picks: [{ playerId: deepGuy.player.id, overall: 8 }],
    board: synth, teams: TEAMS2, slot: 1, rounds: ROUNDS2, slots: SLOTS,
  })
  check('a player the market never drafts is not called a reach', beyond.reach, null)
  check('...he is reported as typically undrafted instead',
    beyond.typicallyUndrafted.map((p) => p.name), [deepGuy.player.name])
  check('...and spending a pick on one passes on nobody', rDef.passedOn.length, 0)

  // Depth ranks must be a legal standing: 1..teams, nobody sharing a place
  // they haven't earned.
  const ranksOk = Array.from({ length: TEAMS2 }, (_, i) =>
    analyzeDraft({ picks: straight, board: synth, teams: TEAMS2, slot: i + 1, rounds: ROUNDS2, slots: SLOTS }),
  )
  check(
    'every depth rank is inside the field',
    ranksOk.every((r) => r.depth.every((d) => d.rank >= 1 && d.rank <= TEAMS2)),
    true,
  )
  check(
    'field ranks are unique across the league',
    new Set(ranksOk.map((r) => r.rankOfField)).size,
    TEAMS2,
  )
  check('no NaN reaches the report', ranksOk.every((r) => Number.isFinite(r.rankOfField)), true)
}

console.log('\ndraft analyzer — an incomplete lineup caps the grade')
{
  // THE regression guard. Measured against real ADP over twelve 18-team
  // drafts, "always take the top of the board" finished 3rd of 18 on starter
  // strength while carrying THREE empty starting slots — six strong starters
  // outweighed three terrible ones in the average. It is also the strategy a
  // reach-based grade would have handed a perfect score. If this check ever
  // goes green without the cap, the analyzer is telling people the worst
  // possible draft was a good one.
  const board2 = {
    entries: Array.from({ length: 200 }, (_, i) => ({
      player: {
        id: `q${i + 1}`,
        // Nothing but backs and receivers near the top, so a team that drafts
        // purely by board position cannot fill QB, TE, K or DEF.
        name: `Q${i + 1}`,
        pos: (i < 120 ? (i % 2 ? 'RB' : 'WR') : (['QB', 'TE', 'K', 'DEF'] as const)[i % 4]) as PoolPlayer['pos'],
        team: 'XXX',
        injury: null,
      },
      adp: i + 1,
      stdev: 5,
      timesDrafted: 10,
      observed: true,
    })),
    meta: { format: 'ppr', totalDrafts: 1, startDate: '', endDate: '', observedCount: 200 },
  }
  const T = 4, R = 9
  const greedy: { playerId: string; overall: number }[] = []
  for (let o = 1; o <= T * R; o++) greedy.push({ playerId: `q${o}`, overall: o })

  const g = analyzeDraft({ picks: greedy, board: board2, teams: T, slot: 1, rounds: R, slots: SLOTS })
  check('taking the top of the board leaves real holes', g.unfilled.length > 0, true)
  check('...so the grade is capped at C however strong the starters', g.grade, 'C')
  check('...and the report says which slots did it', g.cappedBy, g.unfilled)
  check('the underlying field rank is still reported honestly', g.rankOfField >= 1, true)
}

console.log('\ndraft analyzer — who you passed on')
{
  // Slot 1 in a 2-team draft picks at 1 and 4. Taking ADP 3 at pick 1 passes
  // on ADP 1 and ADP 2. Slot 2 then takes ADP 1 at pick 2 and ADP 4 at pick 3,
  // so ADP 2 is still sitting there at pick 4 — survived by construction.
  const b = {
    entries: Array.from({ length: 12 }, (_, i) => ({
      player: { id: `z${i + 1}`, name: `Z${i + 1}`, pos: 'RB' as PoolPlayer['pos'], team: 'X', injury: null },
      adp: i + 1, stdev: 4, timesDrafted: 9, observed: true,
    })),
    meta: { format: 'ppr', totalDrafts: 1, startDate: '', endDate: '', observedCount: 12 },
  }
  const picks = [
    { playerId: 'z3', overall: 1 },
    { playerId: 'z1', overall: 2 },
    { playerId: 'z4', overall: 3 },
    { playerId: 'z2', overall: 4 },
  ]
  const rep = analyzeDraft({ picks, board: b, teams: 2, slot: 1, rounds: 2, slots: SLOTS })
  const first = rep.passedOn.find((x) => x.atOverall === 1)
  check('passing on the best available is recorded', first?.player.name, 'Z1')
  check('...naming who you took instead', first?.tookInstead.name, 'Z3')
  check('...and where he actually went', first?.wentAt, 2)
  check('gone before your next turn is reported as gone', first?.survived, false)

  // Same board, but the passed-on player is never taken at all.
  const picks2 = [
    { playerId: 'z3', overall: 1 },
    { playerId: 'z5', overall: 2 },
    { playerId: 'z6', overall: 3 },
    { playerId: 'z7', overall: 4 },
  ]
  const rep2 = analyzeDraft({ picks: picks2, board: b, teams: 2, slot: 1, rounds: 2, slots: SLOTS })
  const p2 = rep2.passedOn.find((x) => x.atOverall === 1)
  check('a player nobody took counts as having survived', p2?.survived, true)
  check('...and reports no pick number', p2?.wentAt, null)

  // The boundary: you pass on him, wait, and take him yourself next turn. He
  // was on the board the whole time, so waiting worked — the one outcome the
  // feature most wants to be able to show.
  const rep3 = analyzeDraft({
    picks: [
      { playerId: 'z3', overall: 1 },
      { playerId: 'z5', overall: 2 },
      { playerId: 'z6', overall: 3 },
      { playerId: 'z1', overall: 4 },
    ],
    board: b, teams: 2, slot: 1, rounds: 2, slots: SLOTS,
  })
  const p3 = rep3.passedOn.find((x) => x.atOverall === 1)
  check('circling back to him next turn counts as survived', p3?.survived, true)
  check('...and still reports where he went', p3?.wentAt, 4)

  // Take the top of the board every time and there is nobody to have passed on.
  const rep4 = analyzeDraft({
    picks: [
      { playerId: 'z1', overall: 1 },
      { playerId: 'z2', overall: 2 },
      { playerId: 'z3', overall: 3 },
      { playerId: 'z4', overall: 4 },
    ],
    board: b, teams: 2, slot: 1, rounds: 2, slots: SLOTS,
  })
  check('taking the top of the board passes on nobody', rep4.passedOn.length, 0)
}

console.log('\npick advice — the cost of waiting')
{
  /** A board whose positions and ADP we control exactly. */
  const mkBoard = (spec: PoolPlayer['pos'][]) => ({
    entries: spec.map((pos, i) => ({
      player: { id: `s${i + 1}`, name: `${pos}${i + 1}`, pos, team: 'XXX', injury: null },
      adp: i + 1,
      stdev: 8,
      timesDrafted: 20,
      observed: true,
    })),
  })
  const none = new Set<string>()
  const P = (n: number, pos: PoolPlayer['pos']) => Array.from({ length: n }, () => pos)

  // Everything except QB, DEF and K is already filled, mid-draft.
  const filled = [
    { pos: 'RB' as const }, { pos: 'RB' as const }, { pos: 'RB' as const },
    { pos: 'WR' as const }, { pos: 'WR' as const }, { pos: 'TE' as const },
  ]
  const mixed = mkBoard([...P(6, 'WR'), ...P(4, 'RB'), 'QB', ...P(4, 'WR'), 'K', 'DEF', 'QB'])

  const midDraft = suggestPicks({
    entries: mixed.entries, taken: none, myPlayers: filled, slots: SLOTS,
    currentOverall: 60, nextOverall: 95, round: 5, totalRounds: 15,
  })
  check('with only QB, K and DEF open mid-draft, it says take the QB', midDraft.take?.pos, 'QB')
  // Advising a kicker in round five costs someone a startable player, and the
  // opponents will not take one either — the board would be lying to them.
  check('it never suggests a kicker before the end', midDraft.take?.pos !== 'K', true)
  check('...nor a defense', midDraft.take?.pos !== 'DEF', true)
  check('the recommendation fills a starting slot', midDraft.take?.fillsStarter, true)

  // Same board, last two rounds: now K and DEF are exactly what you need.
  const endgame = suggestPicks({
    entries: mixed.entries, taken: none, myPlayers: filled, slots: SLOTS,
    currentOverall: 250, nextOverall: 275, round: 14, totalRounds: 15,
  })
  check('in the last two rounds a kicker or defense becomes fair game',
    ['K', 'DEF', 'QB'].includes(endgame.take?.pos ?? ''), true)

  // A steep tier break must outrank a shallow one when both are about to go.
  // Steep: the only two RBs sit at 1 and 40. Shallow: WRs run 2,3,4,5.
  const cliff = mkBoard(['RB', 'WR', 'WR', 'WR', 'WR', ...P(34, 'QB'), 'RB'])
  const steep = suggestPicks({
    entries: cliff.entries, taken: none, myPlayers: [], slots: SLOTS,
    currentOverall: 3, nextOverall: 30, round: 1, totalRounds: 15,
  })
  check('the position with the cliff behind it wins', steep.take?.pos, 'RB')
  check('...and the drop-off it reports is real', (steep.take?.dropoff ?? 0) > 20, true)

  // Nothing left to start means this is bench shopping, and the honest answer
  // is simply the best player left.
  const complete = [
    { pos: 'QB' as const }, { pos: 'RB' as const }, { pos: 'RB' as const },
    { pos: 'WR' as const }, { pos: 'WR' as const }, { pos: 'TE' as const },
    { pos: 'RB' as const }, { pos: 'K' as const }, { pos: 'DEF' as const },
  ]
  const bench = suggestPicks({
    entries: mixed.entries, taken: none, myPlayers: complete, slots: SLOTS,
    currentOverall: 200, nextOverall: 230, round: 12, totalRounds: 15,
  })
  check('a full lineup switches to best-available', bench.starterComplete, true)
  check('...and still recommends somebody', !!bench.take, true)

  // "You can leave these" must never include something it just told you to take,
  // and must only contain players it actually expects to survive.
  check('canWait never contains the recommendation',
    midDraft.canWait.every((c) => c.pos !== midDraft.take?.pos), true)
  check('canWait only holds positions likely to last',
    midDraft.canWait.every((c) => c.survival >= 0.6), true)

  // A tail past the observed market must not inflate scarcity. On the real
  // board that tail is ~340 players deep with a wide synthetic spread, so every
  // one of them trivially "survives" — counting them reported 103 tight ends
  // available on a panel that was telling you to take one now.
  {
    const withTail = {
      entries: [
        ...mixed.entries,
        ...Array.from({ length: 40 }, (_, i) => ({
          player: { id: `tail${i}`, name: `Tail${i}`, pos: 'QB' as PoolPlayer['pos'], team: 'XXX', injury: null },
          adp: 400 + i, stdev: 24, timesDrafted: 0, observed: false,
        })),
      ],
    }
    const tailed = suggestPicks({
      entries: withTail.entries, taken: none, myPlayers: filled, slots: SLOTS,
      currentOverall: 60, nextOverall: 95, round: 5, totalRounds: 15,
    })
    check('the unobserved tail never counts toward scarcity',
      (tailed.take?.likelyLeft ?? 0) <= (midDraft.take?.likelyLeft ?? 0), true)
  }

  // The scarcity number must never contradict the advice beside it. A raw count
  // of who is left says "66 quarterbacks remaining" off a 600-deep board while
  // the same panel tells you the position is thin.
  check('scarcity counts who survives, not who exists',
    (midDraft.take?.likelyLeft ?? 0) < mixed.entries.filter((e) => e.player.pos === midDraft.take?.pos).length,
    true)

  // On the final pick there is no waiting, so every position is maximally urgent
  // and the advice must still resolve rather than dividing by a turn that
  // does not exist.
  const lastPick = suggestPicks({
    entries: mixed.entries, taken: none, myPlayers: filled, slots: SLOTS,
    currentOverall: 270, nextOverall: null, round: 15, totalRounds: 15,
  })
  check('the last pick still produces advice', !!lastPick.take, true)
  check('...with nothing to wait for', lastPick.canWait.length, 0)

  // An empty board must not crash the panel mid-draft.
  const empty = suggestPicks({
    entries: [], taken: none, myPlayers: filled, slots: SLOTS,
    currentOverall: 60, nextOverall: 95, round: 5, totalRounds: 15,
  })
  check('an exhausted board yields no advice rather than throwing', empty.take, null)
}

console.log('\navailability — the prior behind the plan')
{
  const market = {
    entries: Array.from({ length: 200 }, (_, i) => ({
      player: { id: `a${i + 1}`, name: `A${i + 1}`, pos: 'RB' as PoolPlayer['pos'], team: 'XXX', injury: null },
      adp: i + 1, stdev: 6, timesDrafted: 30, observed: true,
    })),
    meta: { format: 'ppr', totalDrafts: 1, startDate: '', endDate: '', observedCount: 200 },
  }
  const mid = market.entries[59]

  check('long before his slot he is almost certainly there', availabilityAt(mid, 20) > 0.99, true)
  check('long after it he is almost certainly gone', availabilityAt(mid, 100) < 0.01, true)
  check('at his own slot it is a coin flip', Math.abs(availabilityAt(mid, 60) - 0.5) < 0.05, true)

  // Nobody can be gone before the draft starts. A normal centred on ADP 1.5
  // puts mass on picks that do not exist, and untruncated this reported the
  // consensus 1.1 as 57% available at pick one.
  check('everyone is certain to be there at pick 1', availabilityAt(market.entries[0], 1), 1)
  check('...including the very last man on the board', availabilityAt(market.entries[199], 1), 1)
  check('...but it still falls away once picks have happened',
    availabilityAt(market.entries[0], 11) < 0.15, true)
  check('availability decreases as the pick gets later',
    availabilityAt(mid, 30) > availabilityAt(mid, 60) && availabilityAt(mid, 60) > availabilityAt(mid, 90), true)
  check('availability never exceeds certainty', board_entries_all_within_unit(market.entries), true)
}

console.log('\nthe pre-draft plan')
{
  const market = {
    entries: Array.from({ length: 260 }, (_, i) => ({
      player: {
        id: `m${i + 1}`, name: `M${i + 1}`,
        pos: (['RB', 'WR', 'QB', 'TE', 'K', 'DEF'] as const)[i % 6],
        team: 'XXX', injury: null,
      },
      adp: i + 1, stdev: 10, timesDrafted: 40, observed: true,
    })),
    meta: { format: 'ppr', totalDrafts: 1, startDate: '', endDate: '', observedCount: 260 },
  }
  const T = 12, R = 15
  const plan = draftPlan({ board: market, slot: 1, teams: T, rounds: R, slots: SLOTS })

  check('one row per round', plan.length, R)
  check('the picks follow the snake from slot 1', plan.slice(0, 4).map((p) => p.overall), [1, 24, 25, 48])
  check('round numbers line up', plan.slice(0, 3).map((p) => p.round), [1, 2, 3])

  // At the very first pick nothing can have happened yet.
  check('everything is certain at pick 1', plan[0].take?.availability, 1)
  check('...and the plan opens with the consensus 1.1', plan[0].take?.player.name, 'M1')

  // A plan that names the same player twice is not a plan.
  const named = plan.map((p) => p.take?.player.id).filter(Boolean)
  check('nobody is planned for twice', new Set(named).size, named.length)
  check('every round gets a pick', named.length, R)

  // Advising a kicker in round three costs a startable player.
  const early = plan.slice(0, R - 2).map((p) => p.take?.player.pos)
  check('no kicker or defense before the last two rounds',
    early.some((pos) => pos === 'K' || pos === 'DEF'), false)

  // Needs have to evolve or every round recommends a running back.
  check('the first round needs everything', plan[0].stillNeeded.includes('RB'), true)
  const filled = plan.find((p) => !p.stillNeeded.includes('RB'))
  check('RB stops being a need once it is filled', !!filled, true)
  check('by the end nothing is outstanding', plan[R - 1].stillNeeded.length <= 1, true)

  // Everything offered must actually be plausible, and the two buckets must not
  // overlap — "plan around this" and "hope for this" are different claims.
  check('likely really is likely',
    plan.every((p) => p.likely.every((c) => c.availability >= 0.75)), true)
  check('stretch really is a stretch',
    plan.every((p) => p.stretch.every((c) => c.availability < 0.75 && c.availability >= 0.4)), true)
  check('the pick is never repeated in its own alternatives',
    plan.every((p) => !p.likely.concat(p.stretch).some((c) => c.player.id === p.take?.player.id)),
    true)

  // The last slot in the league picks back-to-back at the turn.
  const last = draftPlan({ board: market, slot: T, teams: T, rounds: R, slots: SLOTS })
  check('slot 12 picks at the turn', last.slice(0, 3).map((p) => p.overall), [12, 13, 36])
  check('...and still fills a legal lineup',
    last[R - 1].stillNeeded.length <= 1, true)

  // An exhausted board must not crash the sheet.
  const thin = { entries: market.entries.slice(0, 3), meta: market.meta }
  check('a nearly empty board still returns a row per round',
    draftPlan({ board: thin, slot: 1, teams: T, rounds: R, slots: SLOTS }).length, R)
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
