// SPDX-License-Identifier: GPL-3.0-or-later
// Calibration patterns in the app (BURN-32): generate a pattern for the active
// machine and material (aria-burn-core/calibration), preview its G-code through
// the same parser and planner as any file, save it for the laser, and after
// the real burn "pick the best cell": the user clicks the cell that looked
// right and its settings are kept as a named material setting.

import { PATTERN_KINDS, PatternFitError, cellAt, generatePattern, type CalibrationPattern, type PatternCell, type PatternKind } from 'aria-burn-core/calibration'
import type { MachineProfile, MaterialProfile } from 'aria-burn-core/contract'
import { app } from './app.svelte.ts'
import { burn } from './burn.svelte.ts'
import { isTauri, saveExport } from './ipc.ts'
import { addSetting, emptyMaterialSettings, removeSetting, settingFromCell, type MaterialSettingsLibrary } from './material-settings.ts'
import { loadMaterialSettings, saveMaterialSettings } from './settings.ts'

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
  /** The pattern opened in the burn view (its cells are what a click picks from). */
  previewed = $state.raw<CalibrationPattern | null>(null)
  selectedId = $state<string | null>(null)
  hoverId = $state<string | null>(null)
  library = $state<MaterialSettingsLibrary>(emptyMaterialSettings())
  note = $state<string | null>(null)

  async load(): Promise<void> {
    const { library, warnings } = await loadMaterialSettings()
    this.library = library
    if (warnings.length) app.warnings = [...app.warnings, ...warnings]
  }

  /** Generates the chosen pattern; the error message (bed too small…) when it can't. */
  generate(machine: MachineProfile, material: MaterialProfile, kind = this.kind): { pattern: CalibrationPattern | null; error: string | null } {
    try {
      const origin = this.placement.originMm
      return { pattern: generatePattern(kind, machine, material, origin ? { originMm: origin } : {}), error: null }
    } catch (e) {
      return { pattern: null, error: e instanceof PatternFitError ? e.message : String(e) }
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
    return p ? cellAt(p, xMm, yMm) : null
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
