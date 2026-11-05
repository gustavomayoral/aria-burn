// SPDX-License-Identifier: GPL-3.0-or-later
// Calibration patterns in the app (BURN-32): generate a pattern for the active
// machine and material (aria-burn-core/calibration), preview its G-code through
// the same parser and planner as any file, save it for the laser, and after
// the real burn "pick the best cell": the user clicks the cell that looked
// right and its settings are kept as a named material setting.
//
// BURN-47's measurement patterns pick differently (the pattern's `pick`): the
// first line that marked (firing threshold), the thinnest line (focus height),
// or a strip whose forward/back shift the user measured (scan offset). Those
// picks are kept as machine readings, not material settings.

import {
  PATTERN_KINDS,
  PatternFitError,
  cellAt,
  generatePattern,
  type CalibrationPattern,
  type FocusZMode,
  type PatternCell,
  type PatternKind,
} from 'aria-burn-core/calibration'
import type { MachineProfile, MaterialProfile } from 'aria-burn-core/contract'
import { app } from './app.svelte.ts'
import { burn } from './burn.svelte.ts'
import { isTauri, saveExport } from './ipc.ts'
import { addReading, emptyMachineReadings, readingFromCell, removeReading, type MachineReadingsLibrary, type ReadingInput } from './machine-readings.ts'
import { addSetting, emptyMaterialSettings, removeSetting, settingFromCell, type MaterialSettingsLibrary } from './material-settings.ts'
import { loadMachineReadings, loadMaterialSettings, saveMachineReadings, saveMaterialSettings } from './settings.ts'

export { PATTERN_KINDS }

/** File name the pattern's G-code opens and saves under; also how the burn view's job is recognised as this pattern. */
export const patternFileName = (p: Pick<CalibrationPattern, 'kind' | 'material'>) => `aria-${p.kind}-${p.material.id}.gcode`

export interface PlacementInput {
  /** Lower-left of the burned area (mm); null = automatic, near the bed origin. */
  originMm: { x: number; y: number } | null
}

class CalibrationState {
  /** The pattern dialog is open. */
  open = $state(false)
  kind = $state<PatternKind>('grid')
  placement = $state<PlacementInput>({ originMm: null })
  /** Focus height: pause for the operator (default, no Z commanded) or step a motorised Z. */
  focusZMode = $state<FocusZMode>('pause')
  /** The pattern opened in the burn view (its cells are what a click picks from). */
  previewed = $state.raw<CalibrationPattern | null>(null)
  selectedId = $state<string | null>(null)
  hoverId = $state<string | null>(null)
  library = $state<MaterialSettingsLibrary>(emptyMaterialSettings())
  readings = $state<MachineReadingsLibrary>(emptyMachineReadings())
  note = $state<string | null>(null)

  async load(): Promise<void> {
    const [settings, readings] = await Promise.all([loadMaterialSettings(), loadMachineReadings()])
    this.library = settings.library
    this.readings = readings.library
    const warnings = [...settings.warnings, ...readings.warnings]
    if (warnings.length) app.warnings = [...app.warnings, ...warnings]
  }

  /** Generates the chosen pattern; the error message (bed too small…) when it can't. */
  generate(machine: MachineProfile, material: MaterialProfile, kind = this.kind): { pattern: CalibrationPattern | null; error: string | null } {
    try {
      const origin = this.placement.originMm
      const pattern = kind === 'focus-height' ? { zMode: this.focusZMode } : undefined
      return { pattern: generatePattern(kind, machine, material, { ...(origin ? { originMm: origin } : {}), ...(pattern ? { pattern } : {}) }), error: null }
    } catch (e) {
      return { pattern: null, error: e instanceof PatternFitError || e instanceof RangeError ? e.message : String(e) }
    }
  }

  /** The burn view shows this pattern's G-code (so clicks pick cells). */
  get active(): CalibrationPattern | null {
    const p = this.previewed
    const job = burn.job
    return p && job && job.kind === 'file' && app.source === 'file' && job.name === patternFileName(p) ? p : null
  }

  get selected(): PatternCell | null {
    return this.active?.cells.find((c) => c.id === this.selectedId) ?? null
  }

  /** Opens the pattern in the burn view: parse, plan and simulate like any file. */
  async preview(pattern: CalibrationPattern): Promise<void> {
    this.previewed = pattern
    this.selectedId = null
    this.hoverId = null
    this.open = false
    app.source = 'file'
    await burn.openFile({ kind: 'text', name: patternFileName(pattern), text: pattern.gcode })
  }

  /** Saves the G-code to Downloads (desktop) or as a browser download. */
  async saveGcode(pattern: CalibrationPattern): Promise<string> {
    const name = patternFileName(pattern)
    const bytes = new TextEncoder().encode(pattern.gcode)
    if (isTauri()) return saveExport(name, bytes)
    const url = URL.createObjectURL(new Blob([bytes], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = name
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return name
  }

  cellAt(xMm: number, yMm: number): PatternCell | null {
    const p = this.active
    if (!p) return null
    // Lines are a spot wide: take the nearest one within half the line pitch.
    const pitch = typeof p.options.pitchMm === 'number' ? p.options.pitchMm : 0
    return cellAt(p, xMm, yMm, p.pick === 'first-visible' || p.pick === 'thinnest' ? Math.max(0.5, pitch / 2) : 0.5)
  }

  /** A click on the burn view at (x, y) mm. */
  pickAt(xMm: number, yMm: number): void {
    const c = this.cellAt(xMm, yMm)
    if (c) this.selectedId = c.id
  }

  hoverAt(xMm: number, yMm: number): void {
    this.hoverId = this.cellAt(xMm, yMm)?.id ?? null
  }

  /** Keeps the selected cell's settings under `name`; survives a restart. */
  async saveSelected(name: string): Promise<void> {
    const p = this.active
    const c = this.selected
    if (!p || !c) return
    const setting = settingFromCell(p, c, name)
    const next = addSetting(this.library, setting)
    await saveMaterialSettings(next)
    this.library = next
    this.note = `Saved “${setting.name}”`
    setTimeout(() => (this.note = null), 5000)
  }

  /** Keeps the selected line or strip as a machine reading (measurement patterns); survives a restart. */
  async saveReading(input: ReadingInput = {}): Promise<void> {
    const p = this.active
    const c = this.selected
    if (!p || !c) return
    const next = addReading(this.readings, readingFromCell(p, c, input))
    await saveMachineReadings(next)
    this.readings = next
    this.note = 'Reading saved'
    setTimeout(() => (this.note = null), 5000)
  }

  async removeReading(id: string): Promise<void> {
    const next = removeReading(this.readings, id)
    await saveMachineReadings(next)
    this.readings = next
  }

  async remove(id: string): Promise<void> {
    const next = removeSetting(this.library, id)
    await saveMaterialSettings(next)
    this.library = next
  }

  close(): void {
    this.previewed = null
    this.selectedId = null
    this.hoverId = null
  }
}

export const calibration = new CalibrationState()
