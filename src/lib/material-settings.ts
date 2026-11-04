// SPDX-License-Identifier: GPL-3.0-or-later
// Named material settings (BURN-32): the power, speed and line interval a user
// picked from a burned calibration pattern ("pick the best cell"), for a
// material on a machine. Pure logic; persistence is in settings.ts (store key
// `materialSettings`, beside `settings` and `machines`).

import type { CalibrationPattern, PatternCell, PatternKind, ScanAxis } from 'aria-burn-core/calibration'

export const MATERIAL_SETTINGS_VERSION = 1

export interface MaterialSetting {
  id: string
  name: string
  materialId: string
  /** The machine the pattern was generated for; settings carry over only to the same laser. */
  machine: { name: string; frameId?: string; moduleId?: string }
  op: 'fill' | 'line'
  /** Commanded S (0..$30) and the same as % of $30. */
  s: number
  powerPct: number
  feedMmPerMin: number
  intervalMm?: number
  scan?: ScanAxis
  /** Nominal incident energy per area (J/mm²) the cell was burned with. */
  energyJPerMm2: number
  /** Where it was picked from. */
  source: { pattern: PatternKind; cellId: string; cellLabel: string; pickedAt: string }
}

export interface MaterialSettingsLibrary {
  version: typeof MATERIAL_SETTINGS_VERSION
  settings: MaterialSetting[]
}

export const emptyMaterialSettings = (): MaterialSettingsLibrary => ({ version: MATERIAL_SETTINGS_VERSION, settings: [] })

/** A default name for a picked cell, e.g. "Birch 45% 1800". */
export function suggestName(materialName: string, cell: PatternCell): string {
  const short = materialName.replace(/\s*\(.*\)\s*$/, '').split(/[\s/]+/)[0] ?? materialName
  const s = cell.settings
  const pct = s.powerPct >= 10 ? s.powerPct.toFixed(0) : s.powerPct.toFixed(1)
  return `${short} ${pct}% ${s.feedMmPerMin}${s.intervalMm ? ` @${s.intervalMm}` : ''}`.trim()
}

export function settingFromCell(pattern: CalibrationPattern, cell: PatternCell, name: string, pickedAt = new Date()): MaterialSetting {
  const s = cell.settings
  const m = pattern.machine
  return {
    id: `ms-${pickedAt.getTime().toString(36)}-${cell.id}`,
    name: name.trim() || suggestName(pattern.material.name, cell),
    materialId: pattern.material.id,
    machine: { name: m.name, ...(m.frameId ? { frameId: m.frameId } : {}), ...(m.moduleId ? { moduleId: m.moduleId } : {}) },
    op: s.op,
    s: s.s,
    powerPct: s.powerPct,
    feedMmPerMin: s.feedMmPerMin,
    ...(s.intervalMm !== undefined ? { intervalMm: s.intervalMm } : {}),
    ...(s.scan ? { scan: s.scan } : {}),
    energyJPerMm2: s.energyJPerMm2,
    source: { pattern: pattern.kind, cellId: cell.id, cellLabel: cell.label, pickedAt: pickedAt.toISOString() },
  }
}

export const addSetting = (lib: MaterialSettingsLibrary, setting: MaterialSetting): MaterialSettingsLibrary => ({
  ...lib,
  settings: [...lib.settings.filter((s) => s.id !== setting.id), setting],
})

export const removeSetting = (lib: MaterialSettingsLibrary, id: string): MaterialSettingsLibrary => ({
  ...lib,
  settings: lib.settings.filter((s) => s.id !== id),
})

export const settingsFor = (lib: MaterialSettingsLibrary, materialId: string): MaterialSetting[] =>
  lib.settings.filter((s) => s.materialId === materialId)

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown, min = 0) => typeof v === 'number' && Number.isFinite(v) && v >= min
const str = (v: unknown) => typeof v === 'string' && v.length > 0

/** Problems with a stored setting; empty means it loads. */
export function settingProblems(v: unknown): string[] {
  if (!isObject(v)) return ['not an object']
  const p: string[] = []
  for (const k of ['id', 'name', 'materialId']) if (!str(v[k])) p.push(`${k} missing`)
  if (v.op !== 'fill' && v.op !== 'line') p.push('op must be fill or line')
  for (const k of ['s', 'powerPct', 'energyJPerMm2']) if (!num(v[k])) p.push(`${k} must be a number ≥ 0`)
  if (!num(v.feedMmPerMin, 1)) p.push('feedMmPerMin must be > 0')
  if (v.intervalMm !== undefined && !num(v.intervalMm, 1e-6)) p.push('intervalMm must be > 0')
  if (v.scan !== undefined && v.scan !== 'x' && v.scan !== 'y') p.push('scan must be x or y')
  if (!isObject(v.machine) || !str(v.machine.name)) p.push('machine.name missing')
  if (!isObject(v.source) || !str(v.source.pattern) || !str(v.source.cellId)) p.push('source missing')
  return p
}

/** The stored library, with invalid entries dropped and named in `warnings`. */
export function readMaterialSettings(stored: unknown): { library: MaterialSettingsLibrary; warnings: string[] } {
  const library = emptyMaterialSettings()
  const warnings: string[] = []
  if (stored === undefined || stored === null) return { library, warnings }
  if (!isObject(stored) || !Array.isArray(stored.settings)) return { library, warnings: ['material settings were unreadable; starting empty'] }
  for (const s of stored.settings) {
    const problems = settingProblems(s)
    if (problems.length) warnings.push(`dropped material setting ${isObject(s) && str(s.name) ? `“${String(s.name)}”` : ''} (${problems[0]})`.replace('  ', ' '))
    else library.settings.push(s as MaterialSetting)
  }
  return { library, warnings }
}
