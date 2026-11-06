// SPDX-License-Identifier: GPL-3.0-or-later
// Layer panel state (BURN-53): rows, edits and what reaches svgJob.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadMachineProfile } from 'aria-burn-core'
import { readSvg, type SvgDocument } from 'aria-burn-core/svg'
import { describe, expect, it } from 'vitest'
import { applyPatch, carryLayers, initialLayers, jobLayers, layerRows, nothingBurns, patchLayer } from './svg-layers.ts'
import { createHandler } from './svg-work.ts'

const fixture = (name: string) => readFileSync(fileURLToPath(import.meta.resolve(`aria-burn-core/svg/fixtures/${name}`)), 'utf8')
const svg = (attrs: string, body: string): SvgDocument => readSvg(`<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`)

describe('layer panel state', () => {
  it('an Aria Studio laser SVG gives one row per colour with its paths and length', () => {
    const doc = readSvg(fixture('aria-studio-laser.svg'))
    const layers = initialLayers(doc)
    expect(layers.map((l) => l.id)).toEqual(doc.layers.map((l) => l.id))
    const rows = layerRows(doc, layers)
    for (const [i, r] of rows.entries()) {
      const d = doc.layers[i]!
      expect(r.color).toBe(d.color)
      expect(r.settings.mode).toBe('line')
      // Stroke-only export: every shape is a stroke member, so the row counts them all.
      expect(r.paths).toBe(d.pathCount)
      expect(r.lengthMm).toBeCloseTo(d.lengthMm, 6)
      expect(r.skipped).toBe(0)
    }
  })

  it('line rows leave out shapes there only by default fill; fill rows leave out open paths', () => {
    const doc = svg(
      'width="50mm" height="50mm" viewBox="0 0 50 50"',
      '<path d="M5,5 H15" stroke="#ff0000"/><rect x="30" y="30" width="5" height="5" fill="#000000"/><path d="M5,40 H15" fill="none" stroke="#000000"/>',
    )
    const layers = initialLayers(doc)
    const c00 = () => layerRows(doc, layers).find((r) => r.id === 'C00')!
    expect([c00().paths, c00().skipped]).toEqual([2, 1])
    const filled = patchLayer(layers, 'C00', { mode: 'fill' })
    const row = layerRows(doc, filled).find((r) => r.id === 'C00')!
    // Only the rect is closed; both open paths are skipped in fill mode.
    expect([row.paths, row.skipped]).toEqual([1, 2])
    expect(row.lengthMm).toBeCloseTo(20, 6)
  })

  it('edits stay valid: power 0–100 with min ≤ max, speed ≥ 1, whole passes 1–50, interval > 0, overscan ≥ 0', () => {
    const s = initialLayers(readSvg(fixture('aria-studio-laser.svg')))[0]!.settings
    expect(applyPatch(s, { maxPowerPct: 140 }).maxPowerPct).toBe(100)
    expect(applyPatch(s, { maxPowerPct: -5 }).maxPowerPct).toBe(0)
    const raised = applyPatch(s, { minPowerPct: 60 })
    expect([raised.minPowerPct, raised.maxPowerPct]).toEqual([60, 60])
    const lowered = applyPatch({ ...s, minPowerPct: 20 }, { maxPowerPct: 10 })
    expect([lowered.minPowerPct, lowered.maxPowerPct]).toEqual([10, 10])
    expect(applyPatch(s, { speedMmPerMin: 0 }).speedMmPerMin).toBe(1)
    expect(applyPatch(s, { passes: 2.6 }).passes).toBe(3)
    expect(applyPatch(s, { passes: 0 }).passes).toBe(1)
    expect(applyPatch(s, { passes: 900 }).passes).toBe(50)
    // An emptied field (NaN) keeps the old value.
    expect(applyPatch(s, { speedMmPerMin: Number.NaN }).speedMmPerMin).toBe(s.speedMmPerMin)
    const f = applyPatch(s, { fill: { intervalMm: 0, overscanMm: -1, angleDeg: 45, crosshatch: true } }).fill
    expect(f).toEqual({ ...s.fill, intervalMm: 0.01, overscanMm: 0, angleDeg: 45, crosshatch: true })
    // The original is untouched.
    expect(s.fill.crosshatch).toBe(false)
  })

  it('patching one layer leaves the others; output off and hidden reach svgJob as settings', () => {
    const doc = readSvg(fixture('aria-studio-laser.svg'))
    const layers = initialLayers(doc)
    expect(layers.length).toBeGreaterThan(1)
    const [a, b] = layers
    const next = patchLayer(patchLayer(layers, a!.id, { output: false }), b!.id, { visible: false, speedMmPerMin: 600 })
    expect(next[0]!.settings).toEqual({ ...a!.settings, output: false })
    expect(next[1]!.settings).toEqual({ ...b!.settings, visible: false, speedMmPerMin: 600 })
    expect(jobLayers(next).map((l) => [l.id, l.settings.output, l.settings.visible])).toEqual(next.map((l) => [l.id, l.settings.output, l.settings.visible]))
    expect(nothingBurns(layerRows(doc, next))).toBe(layers.length === 2)
    expect(nothingBurns(layerRows(doc, next.map((l) => ({ ...l, settings: { ...l.settings, output: false } }))))).toBe(true)
  })

  it('re-reading (72 DPI) keeps the settings and order of layers that still exist', () => {
    const doc = readSvg(fixture('aria-studio-laser.svg'))
    const edited = patchLayer(initialLayers(doc).reverse(), doc.layers[0]!.id, { speedMmPerMin: 777 })
    const again = carryLayers(edited, readSvg(fixture('aria-studio-laser.svg'), { pxPerInch: 72 }))
    expect(again.map((l) => l.id)).toEqual(edited.map((l) => l.id))
    expect(again.find((l) => l.id === doc.layers[0]!.id)!.settings.speedMmPerMin).toBe(777)
  })
})

describe('SVG worker handler', () => {
  const machine = loadMachineProfile(readFileSync(fileURLToPath(import.meta.resolve('aria-burn-core/profiles/provisional/machine-10w-diode.json')), 'utf8'))

  it('reads, then makes a job named after the SVG whose output-off layer writes no burn', () => {
    const handle = createHandler()
    const read = handle({ seq: 1, type: 'read', text: fixture('aria-studio-laser.svg'), pxPerInch: 96 })
    if (read.type !== 'read') throw new Error(JSON.stringify(read))
    const doc = read.doc
    const layers = initialLayers(doc)
    const all = handle({ seq: 2, type: 'job', layers: jobLayers(layers), machine, name: 'aria.svg' })
    if (all.type !== 'job') throw new Error(JSON.stringify(all))
    expect(all.gcode).toContain(`; Layer ${layers[0]!.id}`)
    const off = handle({ seq: 3, type: 'job', layers: jobLayers(patchLayer(layers, layers[0]!.id, { output: false })), machine, name: 'aria.svg' })
    if (off.type !== 'job') throw new Error(JSON.stringify(off))
    expect(off.gcode).not.toContain(`; Layer ${layers[0]!.id}`)
    expect(off.gcode.length).toBeLessThan(all.gcode.length)
  })

  it('reports an unreadable SVG and a job before any read', () => {
    const handle = createHandler()
    expect(handle({ seq: 1, type: 'job', layers: [], machine, name: 'x.svg' })).toMatchObject({ type: 'error' })
    expect(handle({ seq: 2, type: 'read', text: '<html></html>', pxPerInch: 96 })).toMatchObject({ seq: 2, type: 'error' })
  })
})
