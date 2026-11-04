// SPDX-License-Identifier: GPL-3.0-or-later
// "Pick the best cell" (BURN-32): a cell picked on a previewed pattern is saved
// as a named material setting and is still there after a restart.

import { generatePattern } from 'aria-burn-core/calibration'
import { afterEach, describe, expect, it } from 'vitest'
import { app } from './app.svelte.ts'
import { burn } from './burn.svelte.ts'
import { calibration, patternFileName } from './calibration.svelte.ts'
import { readMaterialSettings, settingFromCell, suggestName } from './material-settings.ts'
import { findMaterial } from './materials.ts'
import { defaultSettings, loadMaterialSettings, useBackend, type Backend } from './settings.ts'

/** A store file that outlives the app: each `boot` is a fresh backend over the same data. */
function storeFile() {
  const data = new Map<string, string>()
  return {
    data,
    boot(): Backend {
      return {
        read: async (k) => (data.has(k) ? JSON.parse(data.get(k)!) : undefined),
        write: async (k, v) => void data.set(k, JSON.stringify(v)),
      }
    },
  }
}

const wood = findMaterial('birch-ply-provisional')
const machine = defaultSettings().machine

/** What the burn view looks like once the pattern's G-code has been opened. */
function showPattern(p: ReturnType<typeof generatePattern>) {
  calibration.previewed = p
  app.source = 'file'
  burn.job = { kind: 'file', jobId: 1, name: patternFileName(p), model: p.job, diagnostics: [], durationS: 1, samples: 0, batches: 0, mismatch: null, aborted: null }
}

afterEach(() => {
  useBackend(null)
  calibration.close()
  burn.job = null
})

describe('pick the best cell', () => {
  it('saves the clicked cell as a material setting that survives a restart', async () => {
    const file = storeFile()
    useBackend(file.boot())
    await calibration.load()
    expect(calibration.library.settings).toEqual([])

    const p = generatePattern('grid', machine, wood)
    showPattern(p)
    const cell = p.cells.find((c) => c.id === 'r3c5')!
    // A click in the middle of the cell, in machine mm.
    calibration.pickAt((cell.rectMm.minXMm + cell.rectMm.maxXMm) / 2, (cell.rectMm.minYMm + cell.rectMm.maxYMm) / 2)
    expect(calibration.selected?.id).toBe('r3c5')
    await calibration.saveSelected('Birch shading')

    // Restart: new backend over the same store file, fresh state.
    useBackend(file.boot())
    calibration.library = { version: 1, settings: [] }
    await calibration.load()
    const [saved] = calibration.library.settings
    expect(saved).toMatchObject({
      name: 'Birch shading',
      materialId: wood.id,
      op: 'fill',
      s: cell.settings.s,
      powerPct: cell.settings.powerPct,
      feedMmPerMin: cell.settings.feedMmPerMin,
      intervalMm: cell.settings.intervalMm,
      scan: 'x',
      source: { pattern: 'grid', cellId: 'r3c5' },
    })
    expect(saved!.machine.name).toBe(machine.name)

    await calibration.remove(saved!.id)
    useBackend(file.boot())
    expect((await loadMaterialSettings()).library.settings).toEqual([])
  })

  it('picks nothing outside the cells or when another file is open', () => {
    const p = generatePattern('equal-energy', machine, wood)
    showPattern(p)
    calibration.pickAt(-50, -50)
    expect(calibration.selectedId).toBeNull()
    const c = p.cells[0]!
    burn.job!.name = 'something-else.gcode'
    calibration.pickAt(c.rectMm.minXMm + 0.1, c.rectMm.minYMm + 0.1)
    expect(calibration.selected).toBeNull()
  })

  it('drops invalid stored settings with a warning', () => {
    const p = generatePattern('line-interval', machine, wood)
    const good = settingFromCell(p, p.cells[2]!, '', new Date('2026-11-04T12:00:00Z'))
    expect(good.name).toBe(suggestName(wood.name, p.cells[2]!))
    const { library, warnings } = readMaterialSettings({ version: 1, settings: [good, { ...good, id: 'x', feedMmPerMin: -1 }, 'junk'] })
    expect(library.settings).toEqual([good])
    expect(warnings).toHaveLength(2)
  })
})
