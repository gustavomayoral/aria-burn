// SPDX-License-Identifier: GPL-3.0-or-later
// BURN-46: the Height view's ×1/×5/×20 depth exaggeration is on screen only.
// The mesh scales; the hover readout, the depth scale and the exported height
// map keep true depth whatever the setting.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { DEFAULT_EXAGGERATION, EXAGGERATIONS, depthLabel, heightPngValues, reliefZ } from './relief.ts'
import { defaultSettings, mergeSettings, SETTINGS_VERSION } from './settings.ts'

// 3 × 2 heightmap, row 0 = min Y; deepest cut 0.25 mm.
const hm = { width: 3, height: 2, depthMm: new Float32Array([0, 0.05, 0.1, 0.15, 0.2, 0.25]) }
const src = fileURLToPath(new URL('../', import.meta.url))
const read = (rel: string) => readFileSync(src + rel, 'utf8')

describe('depth exaggeration', () => {
  it('scales only the on-screen mesh', () => {
    expect(reliefZ(0.2, 1)).toBeCloseTo(-0.2)
    expect(reliefZ(0.2, 5)).toBeCloseTo(-1)
    expect(reliefZ(0.2, 20)).toBeCloseTo(-4)
    expect(reliefZ(0, 20)).toBe(0)
  })

  it('leaves the exported height map at true depth for every setting', () => {
    const exports = EXAGGERATIONS.map((f) => {
      const settings = defaultSettings()
      settings.ui.reliefExaggeration = f
      const { values, maxMm } = heightPngValues(hm)
      return { values: [...values], name: depthLabel(maxMm) }
    })
    for (const e of exports) expect(e).toEqual(exports[0])
    // Top-down rows: the max-Y row (0.15, 0.2, 0.25 mm) comes first; black = 0.25 mm.
    expect(exports[0]!.values).toEqual([26214, 13107, 0, 65535, 52428, 39321])
    expect(exports[0]!.name).toBe('250um')
  })

  it('is read by the Height view mesh only, never by the readout, depth scale or export', () => {
    for (const file of ['lib/export.ts', 'lib/burn.svelte.ts', 'components/InfoPanel.svelte', 'components/CanvasArea.svelte']) {
      expect(read(file), file).not.toMatch(/reliefExaggeration|reliefZ/)
    }
    const view = read('components/HeightView.svelte')
    // The depth scale's maximum is the true deepest cut, not the scaled one.
    expect(view).toMatch(/burn\.depthMaxMm = max\n/)
    expect(view).toMatch(/On screen only/)
  })

  it('is remembered per user and falls back to the default when invalid', () => {
    expect(defaultSettings().ui.reliefExaggeration).toBe(DEFAULT_EXAGGERATION)
    expect(mergeSettings({ version: SETTINGS_VERSION, ui: { reliefExaggeration: 20 } }).settings.ui.reliefExaggeration).toBe(20)
    expect(mergeSettings({ version: SETTINGS_VERSION, ui: { reliefExaggeration: 7 } }).settings.ui.reliefExaggeration).toBe(DEFAULT_EXAGGERATION)
    expect(mergeSettings({ version: SETTINGS_VERSION, ui: { reliefExaggeration: '20' } }).settings.ui.reliefExaggeration).toBe(DEFAULT_EXAGGERATION)
  })
})
