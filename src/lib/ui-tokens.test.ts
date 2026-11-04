// SPDX-License-Identifier: GPL-3.0-or-later
// The UI's colours, fonts, type sizes, radii, shadows and stacking come only
// from the tokens in src/app.css :root, and those take the shared look from the
// Aria theme (@aria/theme, BURN-28/29) rather than copying it, so Aria Burn
// and Aria Studio can't drift apart. Like Aria Studio's uiTokens.test.ts, the
// type scale is 11/12/13/14 px only.
//
// Burn-render code is exempt from the component rules and held to the opposite
// one: the burn and anything showing simulated material colour (lib/verdicts.ts
// swatches, lib/materials.ts, the core's burn view, the Height view's 3D scene)
// must stay physically true, so it never reads a theme variable.

import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const src = fileURLToPath(new URL('../', import.meta.url))
const read = (rel: string) => readFileSync(src + rel, 'utf8')
const themeCss = readFileSync(fileURLToPath(new URL('../../node_modules/@aria/theme/theme.css', import.meta.url)), 'utf8')

const files = [
  'App.svelte',
  ...readdirSync(src + 'components')
    .filter((f) => f.endsWith('.svelte'))
    .map((f) => `components/${f}`),
]

/** `--name: value` declarations in a block of CSS. */
const declarations = (css: string) => new Map([...css.matchAll(/^\s*(--[a-z0-9-]+):\s*([^;]+);/gm)].map((m) => [m[1]!, m[2]!.trim()]))
const theme = declarations(themeCss)

const appCss = read('app.css')
const rootStart = appCss.indexOf(':root {')
const rootEnd = appCss.indexOf('\n}', rootStart) + 2
const root = declarations(appCss.slice(rootStart, rootEnd))
const outsideRoot = appCss.slice(0, rootStart) + appCss.slice(rootEnd)

const TYPE_SCALE = ['--text-2xs', '--text-xs', '--text-ui', '--text-sm']

const RULES: [string, RegExp][] = [
  ['raw hex colour', /#[0-9a-fA-F]{3,8}\b/g],
  ['raw rgb()/hsl() colour', /\b(?:rgba?|hsla?)\(/g],
  ['font size off the 11/12/13/14 px scale', new RegExp(String.raw`font-size:\s*(?![\s]|var\((?:${TYPE_SCALE.join('|')})\)|inherit)[^;]+`, 'g')],
  ['font family outside the tokens', /font-family:\s*(?![\s]|var\(|inherit)[^;]+/g],
  ['raw z-index', /z-index:\s*\d/g],
  ['raw border radius', /border-radius:\s*(?![\s]|var\(|50%|999px|0\b)[^;]+/g],
  ['theme variable read directly (use the app.css token)', /var\(--aria-/g],
]

function problems(text: string, rules = RULES): string[] {
  const out: string[] = []
  for (const [what, re] of rules) for (const m of text.matchAll(re)) out.push(`${what}: ${m[0]}`)
  return out
}

describe('UI tokens', () => {
  it.each(files)('%s uses only app.css tokens', (file) => {
    expect(problems(read(file))).toEqual([])
  })

  it('app.css keeps raw values inside :root', () => {
    // app.css's :root is where the theme is read, so outside it the last rule applies too.
    expect(problems(outsideRoot)).toEqual([])
  })

  it('every token a component uses is defined', () => {
    for (const file of [...files, 'app.css'])
      for (const m of read(file).matchAll(/var\((--[a-z0-9-]+)/g)) {
        const name = m[1]!
        expect(root.has(name) || (file === 'app.css' && theme.has(name)), `${file} uses ${name}`).toBe(true)
      }
  })

  it('has exactly the Aria type scale', () => {
    expect([...root.keys()].filter((k) => /^--text-/.test(k))).toEqual(TYPE_SCALE)
  })
})

describe('Aria theme', () => {
  it('loads the theme before app.css', () => {
    const main = read('main.ts')
    const at = (s: string) => main.indexOf(s)
    expect(at("import '@aria/theme/fonts.css'")).toBeGreaterThan(-1)
    expect(at("import '@aria/theme/theme.css'")).toBeGreaterThan(at("import '@aria/theme/fonts.css'"))
    expect(at("import './app.css'")).toBeGreaterThan(at("import '@aria/theme/theme.css'"))
  })

  it('maps every token Aria Studio has onto its --aria-* variable', () => {
    const unmapped: string[] = []
    for (const [name, value] of root) {
      const bare = name.slice(2)
      const aria = [`--aria-${bare}`, `--aria-bg-${bare}`].find((n) => theme.has(n))
      if (aria && value !== `var(${aria})`) unmapped.push(`${name}: ${value} (expected var(${aria}))`)
    }
    expect(unmapped).toEqual([])
  })

  it('copies no theme value into app.css', () => {
    // Colours, font stacks and shadows; a bare length like 2px is too common to count as a copy.
    const values = new Set([...theme.values()].filter((v) => !/^[\d.]+(?:px)?$/.test(v)).map((v) => v.toLowerCase()))
    const copied = [...root].filter(([, v]) => values.has(v.toLowerCase())).map(([k, v]) => `${k}: ${v}`)
    expect(copied).toEqual([])
  })
})

describe('burn render', () => {
  // Everything that draws or describes the simulated material: the material
  // list's swatches, the verdict colours, the burn canvas and the 3D scene.
  const renderFiles = [
    ...readdirSync(src + 'lib')
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => `lib/${f}`),
    'components/HeightView.svelte',
  ]

  it.each(renderFiles)('%s never reads the theme', (file) => {
    const script = read(file).split('<style>')[0]!
    expect(script).not.toMatch(/--aria-|getComputedStyle|@aria\/theme/)
  })
})
