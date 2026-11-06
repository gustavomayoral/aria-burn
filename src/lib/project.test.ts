// SPDX-License-Identifier: GPL-3.0-or-later
// Project files (BURN-55): build from the SVG import's setup, round trip to
// the same burn, unsaved-change detection, Replace SVG's layer merge, and the
// saved machine and material.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadMachineProfile, parseProject, serializeProject, type MaterialProfile } from 'aria-burn-core'
import { readSvg, svgJob } from 'aria-burn-core/svg'
import { describe, expect, it } from 'vitest'
import { BUILTIN_DEFAULT_ID, catalogMachineId, createMachine, emptyLibrary } from './machines.ts'
import { MATERIALS } from './materials.ts'
import {
  buildProject,
  mergeLayers,
  mergeNote,
  projectFileName,
  resolveMachine,
  resolveMaterial,
  setupKey,
  withProjectExtension,
  type ProjectSetup,
} from './project.ts'
import { initialLayers, jobLayers, patchLayer } from './svg-layers.ts'
import { defaultPlacement, placeGeometry, setRotation } from './svg-place.ts'

const fixture = (name: string) => readFileSync(fileURLToPath(import.meta.resolve(`aria-burn-core/svg/fixtures/${name}`)), 'utf8')
const MACHINE = loadMachineProfile(readFileSync(fileURLToPath(import.meta.resolve('aria-burn-core/profiles/provisional/machine-10w-diode.json')), 'utf8'))
const CTX = { machine: { id: BUILTIN_DEFAULT_ID, name: 'Default (10 W diode)' }, material: { id: MATERIALS[0]!.id, name: MATERIALS[0]!.name } }

function editedSetup(): ProjectSetup {
  const text = fixture('holes.svg')
  const doc = readSvg(text)
  let layers = initialLayers(doc)
  layers = patchLayer(layers, layers[0]!.id, { maxPowerPct: 70, speedMmPerMin: 800, passes: 3, fill: { angleDeg: 30, crosshatch: true } })
  layers = patchLayer(layers, layers[1]!.id, { output: false })
  layers.reverse()
  const g = placeGeometry(doc)
  const placement = { ...setRotation(g, defaultPlacement(g), 20), xMm: 150, yMm: 90 }
  return { name: 'holes.svg', text, pxPerInch: 96, layers, placement }
}

describe('project file round trip (BURN-55)', () => {
  it('saves and reopens the same layers, settings, order and placement', () => {
    const setup = editedSetup()
    const parsed = parseProject(serializeProject(buildProject(setup, { ...CTX, savedAt: '2026-11-06T12:00:00.000Z' })))
    if (!parsed.ok) throw new Error(parsed.error)
    const p = parsed.project
    expect(p.svg).toEqual({ fileName: 'holes.svg', text: setup.text, pxPerInch: 96 })
    expect(p.placement).toEqual(setup.placement)
    expect(p.machine).toEqual(CTX.machine)
    expect(p.material).toEqual(CTX.material)
    const doc = readSvg(p.svg.text, { pxPerInch: p.svg.pxPerInch })
    const merged = mergeLayers(p.layers, doc)
    expect(merged.layers).toEqual(setup.layers)
    expect(merged.dropped).toEqual([])
    expect(merged.added).toEqual([])
  })

  it('the reopened setup makes the same burn', () => {
    const setup = editedSetup()
    const parsed = parseProject(serializeProject(buildProject(setup, CTX)))
    if (!parsed.ok) throw new Error(parsed.error)
    const p = parsed.project
    const before = svgJob(readSvg(setup.text), jobLayers(setup.layers), setup.placement, MACHINE, { name: setup.name })
    const doc = readSvg(p.svg.text, { pxPerInch: p.svg.pxPerInch })
    const after = svgJob(doc, jobLayers(mergeLayers(p.layers, doc).layers), p.placement, MACHINE, { name: p.svg.fileName })
    expect(after.gcode).toBe(before.gcode)
    expect(after.job.moves.length).toBeGreaterThan(0)
  })

  it('a setup change makes the key change; machine and material are not part of it', () => {
    const setup = editedSetup()
    const key = setupKey(setup)
    expect(setupKey({ ...setup })).toBe(key)
    expect(setupKey({ ...setup, placement: { ...setup.placement, xMm: 151 } })).not.toBe(key)
    expect(setupKey({ ...setup, pxPerInch: 72 })).not.toBe(key)
    expect(setupKey({ ...setup, layers: patchLayer(setup.layers, setup.layers[0]!.id, { passes: 4 }) })).not.toBe(key)
    expect(setupKey({ ...setup, layers: [...setup.layers].reverse() })).not.toBe(key)
  })

  it('names project files after the SVG and adds the extension a dialog left out', () => {
    expect(projectFileName('logo.svg')).toBe('logo.ariaburn')
    expect(projectFileName('Logo.SVG')).toBe('Logo.ariaburn')
    expect(projectFileName(null)).toBe('Untitled.ariaburn')
    expect(withProjectExtension('/a/job')).toBe('/a/job.ariaburn')
    expect(withProjectExtension('/a/job.AriaBurn')).toBe('/a/job.AriaBurn')
    expect(withProjectExtension('/a/job.ariaburn.ariaburn')).toBe('/a/job.ariaburn')
  })
})

describe('Replace SVG layer merge (BURN-55)', () => {
  it('keeps settings for colours still there, adds defaults for new ones and lists dropped ones', () => {
    const old = readSvg(fixture('holes.svg'))
    let layers = initialLayers(old)
    const kept = layers.find((l) => l.color === '#0000ff')!
    layers = patchLayer(layers, kept.id, { maxPowerPct: 66 })
    const next = readSvg(
      `<svg xmlns="http://www.w3.org/2000/svg" width="50mm" height="50mm" viewBox="0 0 50 50"><path d="M1,1 H40" stroke="#0000ff" fill="none"/><path d="M1,5 H40" stroke="#00ffff" fill="none"/></svg>`,
    )
    const m = mergeLayers(layers, next)
    expect(m.layers.map((l) => l.color)).toEqual(['#0000ff', '#00ffff'])
    expect(m.layers[0]!.settings.maxPowerPct).toBe(66)
    expect(m.layers[1]!.settings).toEqual(next.layers.find((l) => l.color === '#00ffff')!.settings)
    expect(m.kept).toEqual([kept.name])
    expect(m.added).toEqual([next.layers.find((l) => l.color === '#00ffff')!.name])
    expect(m.dropped.sort()).toEqual(layers.filter((l) => l.color !== '#0000ff').map((l) => l.name).sort())
    expect(mergeNote(m)).toMatch(/^1 layer kept their settings; new with default settings: .+; no longer in the SVG: .+\.$/)
    expect(mergeNote({ kept: ['C00'], added: [], dropped: [] })).toBeNull()
  })
})

describe('saved machine and material (BURN-55)', () => {
  const S30 = catalogMachineId('sculpfun-s30', 'sculpfun-s30-pro-10w')

  it('loads a saved machine that still exists and keeps the active one when it is the same', () => {
    const lib = emptyLibrary()
    expect(resolveMachine({ id: S30, name: 'S30' }, lib, 'Default')).toEqual({ kind: 'load', id: S30 })
    expect(resolveMachine({ id: BUILTIN_DEFAULT_ID, name: 'Default' }, lib, 'Default')).toEqual({ kind: 'keep' })
    const { library, machine } = createMachine(lib, 'Shop laser', MACHINE, {})
    expect(resolveMachine({ id: machine.id, name: 'Shop laser' }, { ...library, activeId: BUILTIN_DEFAULT_ID }, 'Default')).toEqual({ kind: 'load', id: machine.id })
  })

  it('a project saved with a machine since deleted opens on the current machine with a notice', () => {
    const { library, machine } = createMachine(emptyLibrary(), 'Shop laser', MACHINE, {})
    const afterDelete = { activeId: BUILTIN_DEFAULT_ID, machines: library.machines.filter((m) => m.id !== machine.id) }
    const r = resolveMachine({ id: machine.id, name: 'Shop laser' }, afterDelete, 'Default (10 W diode)')
    expect(r).toEqual({
      kind: 'missing',
      notice: 'This project was saved with the machine “Shop laser”, which is no longer in your machines. It opens with Default (10 W diode).',
    })
  })

  it('an unsaved machine profile gets a notice unless it is still the one in use', () => {
    expect(resolveMachine({ id: null, name: 'Tweaked' }, { activeId: null, machines: [] }, 'Tweaked')).toEqual({ kind: 'keep' })
    expect(resolveMachine({ id: null, name: 'Tweaked' }, emptyLibrary(), 'Default')).toMatchObject({ kind: 'missing', notice: expect.stringMatching(/unsaved machine profile/) })
  })

  it('restores a material that still exists, otherwise keeps the current one with a notice', () => {
    const materials = MATERIALS as MaterialProfile[]
    expect(resolveMaterial({ id: materials[1]!.id, name: 'x' }, materials, 'Birch')).toEqual({ kind: 'use', id: materials[1]!.id })
    expect(resolveMaterial({ id: 'my-cork', name: 'My cork' }, materials, 'Birch')).toEqual({
      kind: 'missing',
      notice: 'This project was saved with the material “My cork”, which is no longer available. It opens with Birch.',
    })
  })
})
