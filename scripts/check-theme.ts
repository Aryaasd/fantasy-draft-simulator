/**
 * Theme checks.
 * Run: npm run check:theme
 *
 * Two jobs:
 *  1. The two dark token blocks (media-query and [data-theme='dark']) are
 *     duplicated because CSS can't share a declaration list across a media
 *     boundary. Assert they haven't drifted.
 *  2. Compute WCAG contrast for the pairs that actually carry text, in BOTH
 *     themes. A dark palette that was reasoned about but never measured is
 *     just a guess.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const css = readFileSync(join(here, '..', 'app', 'globals.css'), 'utf8')

let failures = 0
function fail(msg: string) {
  failures++
  console.log(`  FAIL ${msg}`)
}
function ok(msg: string) {
  console.log(`  ok   ${msg}`)
}

// --- token extraction ------------------------------------------------------

function block(selector: string): Record<string, string> {
  const i = css.indexOf(selector)
  if (i === -1) throw new Error(`selector not found: ${selector}`)
  const open = css.indexOf('{', i)
  const close = css.indexOf('}', open)
  const body = css.slice(open + 1, close)
  const out: Record<string, string> = {}
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim()
  }
  return out
}

const light = block(':root {')
const darkMedia = block(":root:not([data-theme='light'])")
const darkAttr = block(":root[data-theme='dark']")

// --- 1. drift --------------------------------------------------------------

console.log('\ndark blocks are in sync')
const kMedia = Object.keys(darkMedia).sort()
const kAttr = Object.keys(darkAttr).sort()
if (kMedia.join(',') !== kAttr.join(',')) {
  fail(`token sets differ\n         media-only: ${kMedia.filter((k) => !kAttr.includes(k))}\n         attr-only:  ${kAttr.filter((k) => !kMedia.includes(k))}`)
} else {
  ok(`same ${kMedia.length} tokens defined in both`)
  const mismatched = kMedia.filter((k) => darkMedia[k] !== darkAttr[k])
  if (mismatched.length) fail(`values differ for: ${mismatched.join(', ')}`)
  else ok('all values identical')
}

// Every dark token must exist in light, or it falls back to nothing.
const missingInLight = kMedia.filter((k) => !(k in light))
if (missingInLight.length) fail(`defined in dark but not light: ${missingInLight.join(', ')}`)
else ok('every dark token has a light counterpart')

// --- 2. contrast -----------------------------------------------------------

type RGBA = { r: number; g: number; b: number; a: number }

function parse(v: string, tokens: Record<string, string>, depth = 0): RGBA {
  if (depth > 5) throw new Error('var() nesting too deep')
  const s = v.trim()

  const varMatch = s.match(/^var\((--[\w-]+)\)$/)
  if (varMatch) return parse(tokens[varMatch[1]], tokens, depth + 1)

  const hex = s.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const h = hex[1]
    const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
      a: 1,
    }
  }

  const rgba = s.match(/^rgba?\(([^)]+)\)$/)
  if (rgba) {
    const parts = rgba[1].split(',').map((p) => parseFloat(p.trim()))
    return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 }
  }

  throw new Error(`cannot parse color: ${v}`)
}

/** Flatten a translucent color onto an opaque backdrop. */
function over(fg: RGBA, bg: RGBA): RGBA {
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  }
}

function luminance(c: RGBA): number {
  const ch = [c.r, c.g, c.b].map((v) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
}

function contrast(fg: RGBA, bg: RGBA): number {
  const a = luminance(fg)
  const b = luminance(bg)
  const [hi, lo] = a > b ? [a, b] : [b, a]
  return (hi + 0.05) / (lo + 0.05)
}

type Sev = 'error' | 'warn'

/** fg token, bg token, minimum ratio, severity, what it's for. */
const PAIRS: [string, string, number, Sev, string][] = [
  ['--text', '--bg', 4.5, 'error', 'body copy on the page'],
  // Position colours are read at a glance and carry real meaning, so they are
  // held to body-text contrast on every surface they appear on — including the
  // zebra-striped sunken rows in the lineup, which are easy to forget.
  ...(['qb', 'rb', 'wr', 'te', 'k', 'def'].flatMap((p) => [
    [`--pos-${p}`, '--bg', 4.5, 'error', `${p.toUpperCase()} label on the page`],
    [`--pos-${p}`, '--surface', 4.5, 'error', `${p.toUpperCase()} label on cards`],
    [`--pos-${p}`, '--surface-sunken', 4.5, 'error', `${p.toUpperCase()} label on striped rows`],
  ]) as [string, string, number, Sev, string][]),
  ['--text', '--surface', 4.5, 'error', 'body copy on cards'],
  ['--muted', '--bg', 4.5, 'error', 'subtitles, secondary copy'],
  ['--muted', '--surface', 4.5, 'error', 'secondary copy on cards'],
  ['--muted-dim', '--bg', 4.5, 'error', 'disclosure, metadata'],
  ['--muted-dim', '--surface', 4.5, 'error', 'placeholders, ac-meta'],
  ['--purple', '--bg', 4.5, 'error', 'links, eyebrow labels, on-clock'],
  ['--purple', '--surface', 4.5, 'error', 'purple text on cards'],
  ['--on-purple', '--purple', 4.5, 'error', 'button label, user chat bubble'],
  ['--danger', '--danger-bg', 4.5, 'error', 'error text'],
  ['--danger', '--bg', 4.5, 'error', 'injury flags'],
  ['--warn', '--warn-bg', 4.5, 'error', 'run warning'],
  ['--purple', '--purple-soft', 3, 'error', 'active chip text on its own tint'],
  // The guide's deep-league callout puts full paragraphs on the purple tint,
  // which the chip pair above never did — that one is a short label at 3:1.
  ['--text', '--purple-soft', 4.5, 'error', 'deep-league callout body'],
  ['--muted', '--purple-soft', 4.5, 'error', 'secondary copy on a tint'],

  // Deliberately a warning, not a failure.
  //
  // WCAG 1.4.11 wants 3:1 for a control's boundary when that boundary is what
  // identifies the control. Our inputs are also identified by a filled surface
  // against the page, a visible label, and a focus state that swaps the border
  // to --purple (>5:1) plus a 3px ring. Pushing the resting border to 3:1 would
  // make every field read as heavily outlined and lose the editorial feel the
  // brand is built on. Surfaced so the tradeoff stays visible rather than
  // forgotten.
  ['--border-strong', '--bg', 3, 'warn', 'resting input border'],
]

for (const [themeName, tokens] of [
  ['light', light],
  ['dark', { ...light, ...darkMedia }],
] as const) {
  console.log(`\ncontrast — ${themeName}`)
  const bg = parse(tokens['--bg'], tokens)

  for (const [fgTok, bgTok, min, sev, use] of PAIRS) {
    let fg: RGBA, back: RGBA
    try {
      fg = parse(tokens[fgTok], tokens)
      back = parse(tokens[bgTok], tokens)
    } catch (e) {
      fail(`${fgTok} on ${bgTok} — ${(e as Error).message}`)
      continue
    }
    // Translucent tokens sit on the page background.
    if (back.a < 1) back = over(back, bg)
    if (fg.a < 1) fg = over(fg, back)

    const ratio = contrast(fg, back)
    const label = `${fgTok} on ${bgTok}  ${ratio.toFixed(2)}:1 (need ${min}) — ${use}`
    if (ratio >= min) ok(label)
    else if (sev === 'warn') console.log(`  warn ${label}`)
    else fail(label)
  }
}

console.log(failures === 0 ? '\nAll theme checks passed.\n' : `\n${failures} FAILED\n`)
process.exit(failures === 0 ? 0 : 1)
