// SPDX-License-Identifier: GPL-3.0-or-later
// Measurement patterns (BURN-47): the first visible line, the thinnest line and
// a measured scan offset are kept as machine readings that name the contract
// field they measure and survive a restart.

import { generatePattern } from 'aria-burn-core/calibration'
import { afterEach, describe, expect, it } from 'vitest'
import { app } from './app.svelte.ts'
import { burn } from './burn.svelte.ts'
import { calibration, patternFileName } from './calibration.svelte.ts'
import { addReading, describeScanOffset, emptyMachineReadings, readMachineReadings, readingFromCell, readingsForProfile, scanOffsetFromReadings } from './machine-readings.ts'
import { findMaterial } from './materials.ts'
import { emptyLibrary } from './machines.ts'
import { defaultSettings, useBackend, type Backend } from './settings.ts'

function storeFile() {
  const data = new Map<string, string>()
  return {
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

describe('machine readings', () => {
  it('keeps the first visible line, the thinnest line and a scan offset across a restart', async () => {
    const file = storeFile()
    useBackend(file.boot())
    await calibration.load()
    expect(calibration.readings.readings).toEqual([])

    const threshold = generatePattern('firing-threshold', machine, wood)
    showPattern(threshold)
    const line = threshold.cells[5]!
    // Lines are a spot wide: a click a little off the line still picks it.
    const y = (line.rectMm.minYMm + line.rectMm.maxYMm) / 2 + 0.8
    calibration.pickAt((line.rectMm.minXMm + line.rectMm.maxXMm) / 2, y)
    expect(calibration.selected?.id).toBe(line.id)
    await calibration.saveReading()

    const focus = generatePattern('focus-height', machine, wood)
    showPattern(focus)
    calibration.selectedId = 'z4'
    await calibration.saveReading({ lineWidthMm: 0.12 })

    const scan = generatePattern('scan-offset', machine, wood)
    showPattern(scan)
    calibration.selectedId = scan.cells[2]!.id
    await expect(calibration.saveReading({})).rejects.toThrow(/shift/)
    await calibration.saveReading({ shiftMm: 0.15 })

    useBackend(file.boot())
    calibration.readings = emptyMachineReadings()
    await calibration.load()
    const byKind = Object.fromEntries(calibration.readings.readings.map((r) => [r.kind, r]))
    expect(byKind['firing-threshold']).toMatchObject({ field: 'LaserModule.powerCurve', inContract: true, s: line.settings.s, powerPct: line.settings.powerPct })
    expect(byKind['focus-height']).toMatchObject({ field: 'LaserModule.spot', zOffsetMm: focus.cells[3]!.extra!.zOffsetMm, lineWidthMm: 0.12 })
    expect(byKind['scan-offset']).toMatchObject({
      field: 'MachineFrame.scanOffsetMm',
      inContract: true, // BURN-48 added the field
      feedMmPerMin: scan.cells[2]!.settings.feedMmPerMin,
      shiftMm: 0.15,
    })
  })

  it('a new reading replaces the same kind on the same machine; scan offsets per feed', () => {
    const scan = generatePattern('scan-offset', machine, wood)
    let lib = emptyMachineReadings()
    lib = addReading(lib, readingFromCell(scan, scan.cells[0]!, { shiftMm: 0.1 }, new Date(1)))
    lib = addReading(lib, readingFromCell(scan, scan.cells[1]!, { shiftMm: 0.2 }, new Date(2)))
    lib = addReading(lib, readingFromCell(scan, scan.cells[0]!, { shiftMm: 0.12 }, new Date(3)))
    expect(lib.readings.map((r) => r.shiftMm).sort()).toEqual([0.12, 0.2])
    const t = generatePattern('firing-threshold', machine, wood)
    lib = addReading(lib, readingFromCell(t, t.cells[3]!, {}, new Date(4)))
    lib = addReading(lib, readingFromCell(t, t.cells[4]!, {}, new Date(5)))
    expect(lib.readings.filter((r) => r.kind === 'firing-threshold').map((r) => r.source.cellId)).toEqual([t.cells[4]!.id])
  })

  it('drops invalid stored readings with a warning', () => {
    const { library, warnings } = readMachineReadings({ version: 1, readings: [{ id: 'x', kind: 'grid' }] })
    expect(library.readings).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  it('refuses a pattern that is not a measurement pattern', () => {
    const grid = generatePattern('grid', machine, wood)
    expect(() => readingFromCell(grid, grid.cells[0]!)).toThrow()
  })
})

describe('applying scan offset readings (BURN-48)', () => {
  const p = generatePattern('scan-offset', machine, wood)
  const pick = (i: number, shiftMm: number, at: number) => readingFromCell(p, p.cells[i]!, { shiftMm }, new Date(at))

  it('turns a machine’s readings into the contract curve, by feed', () => {
    let lib = emptyMachineReadings()
    lib = addReading(lib, pick(2, 0.2, 2))
    lib = addReading(lib, pick(0, 0.05, 1))
    lib = addReading(lib, pick(2, 0.25, 3)) // replaces the first pick at that feed
    const readings = readingsForProfile(lib, 'scan-offset', machine)
    const curve = scanOffsetFromReadings(readings)
    expect(curve).toEqual([
      { feedMmPerMin: p.cells[0]!.settings.feedMmPerMin, offsetMm: 0.05 },
      { feedMmPerMin: p.cells[2]!.settings.feedMmPerMin, offsetMm: 0.25 },
    ])
    expect(describeScanOffset(curve)).toMatch(/^0.05 mm at \d+ · 0.25 mm at \d+ mm\/min$/)
    expect(describeScanOffset([])).toMatch(/^None/)
    // The pattern now names a contract field.
    expect(readings[0]!.inContract).toBe(true)
  })

  it('applied to a built-in, the readings move to the copy it is saved as', async () => {
    useBackend(storeFile().boot())
    app.settings = defaultSettings()
    app.library = emptyLibrary()
    let lib = emptyMachineReadings()
    lib = addReading(lib, pick(0, 0.05, 1))
    lib = addReading(lib, pick(2, 0.25, 2))
    calibration.readings = lib
    const readings = readingsForProfile(lib, 'scan-offset', app.settings.machine)
    const copy = await calibration.applyScanOffsetReadings(readings, scanOffsetFromReadings(readings))
    expect(copy!.name).toMatch(/copy$/)
    expect(app.settings.machine.name).toBe(copy!.name)
    expect(app.settings.machine.scanOffsetMm).toHaveLength(2)
    expect(readingsForProfile(calibration.readings, 'scan-offset', app.settings.machine).map((r) => r.id)).toEqual(readings.map((r) => r.id))
  })

  it('a copy of a catalog machine finds the readings burned on the built-in', () => {
    const catalog = { ...machine, name: 'Sculpfun S30 + S30 Pro 10 W', frameId: 'sculpfun-s30', moduleId: 'sculpfun-s30-pro-10w' }
    const q = generatePattern('scan-offset', catalog, wood)
    const lib = addReading(emptyMachineReadings(), readingFromCell(q, q.cells[1]!, { shiftMm: 0.1 }))
    expect(readingsForProfile(lib, 'scan-offset', { ...catalog, name: 'Sculpfun S30 + S30 Pro 10 W copy' })).toHaveLength(1)
    expect(readingsForProfile(lib, 'scan-offset', { ...catalog, name: 'Other', moduleId: 'sculpfun-s30-5w' })).toHaveLength(0)
  })
})
