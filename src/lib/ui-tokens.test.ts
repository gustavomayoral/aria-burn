// SPDX-License-Identifier: GPL-3.0-or-later
// The UI's colours, fonts, type sizes, shadows and stacking come only from
// the tokens in src/app.css :root, so a restyle (Aria Studio) changes values
// in one place. Burn-render colours (lib/verdicts.ts swatches, the core's burn
// view, the 3D scene) are material and overlay colours, not UI theme, and live
// outside the files checked here.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = fileURLToPath(new URL('../', import.meta.url))
const read = (rel: string) => readFileSync(src + rel, 'utf8')

const files = [
  'App.svelte',
  ...readdirSync(src + 'components')
    .filter((f) => f.endsWith('.svelte'))
    .map((f) => `components/${f}`),
]

const RULES: [string, RegExp][] = [
  ['raw hex colour', /#[0-9a-fA-F]{3,8}\b/g],
  ['raw rgb()/hsl() colour', /\b(?:rgba?|hsla?)\(/g],
  ['pixel font size', /font-size:\s*[\d.]+(?:px|rem|em|pt)/g],
  ['font family outside the tokens', /font-family:\s*(?![\s]|var\(|inherit)[^;]+/g],
  ['raw z-index', /z-index:\s*\d/g],
]

function problems(text: string): string[] {
  const out: string[] = []
  for (const [what, re] of RULES) for (const m of text.matchAll(re)) out.push(`${what}: ${m[0]}`)
  return out
}

describe('UI tokens', () => {
  it.each(files)('%s uses only app.css tokens', (file) => {
    expect(problems(read(file))).toEqual([])
  })

  it('app.css keeps raw values inside :root', () => {
    const css = read('app.css')
    const root = css.indexOf(':root {')
    const outside = css.slice(0, root) + css.slice(css.indexOf('\n}', root) + 2)
    expect(problems(outside)).toEqual([])
  })

  it('every token a component uses is defined', () => {
    const css = read('app.css')
    const defined = new Set([...css.matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]))
    for (const file of [...files, 'app.css'])
      for (const m of read(file).matchAll(/var\((--[a-z0-9-]+)/g)) expect(defined, `${file} uses ${m[1]}`).toContain(m[1])
  })
})
