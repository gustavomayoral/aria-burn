// SPDX-License-Identifier: GPL-3.0-or-later
// Machine readings (BURN-47): what the user read off a burned measurement
// pattern. The firing threshold's first visible line, the focus pattern's
// thinnest line (and its width, if measured), and the scan offset strips'
// forward/back shift. Each reading names the contract field it is evidence for
// (the pattern's `measures`), for the machine it was burned on. Pure logic;
// persistence is in settings.ts (store key `machineReadings`).
//
// Readings are kept, not applied: the profile editor and BURN-15's fit decide
// what to do with them. Scan offset readings are applied only when the user
// asks (BURN-48): `scanOffsetFromReadings` turns them into the profile's
// MachineFrame/MachineProfile.scanOffsetMm curve, and machine-session.ts
// `applyScanOffset` writes it into the machine.

import type { CalibrationPattern, PatternCell, PatternKind } from 'aria-burn-core/calibration'
import { SCAN_OFFSET_MAX_MM, type MachineProfile, type ScanOffsetPoint } from 'aria-burn-core/contract'

export const MACHINE_READINGS_VERSION = 1

export type ReadingKind = 'firing-threshold' | 'focus-height' | 'scan-offset'
export const READING_KINDS: readonly ReadingKind[] = ['firing-threshold', 'focus-height', 'scan-offset']
export const isReadingKind = (k: PatternKind): k is ReadingKind => (READING_KINDS as readonly string[]).includes(k)

export interface MachineReading {
  id: string
  kind: ReadingKind
  machine: { name: string; frameId?: string; moduleId?: string }
  /** Contract field the reading measures, e.g. "LaserModule.powerCurve". */
  field: string
  /** False when the contract had no field for it when picked (scan offset before BURN-48). */
  inContract: boolean
  materialId: string
  /** Firing threshold: S of the first line that marked (0..$30), and as % of $30. */
  s?: number
  powerPct?: number
  /** Focus: Z offset of the thinnest line from the starting focus (mm, + = head up). */
  zOffsetMm?: number
  /** Focus: measured width of that line (mm), if the user measured it. */
  lineWidthMm?: number
  /** Scan offset: the strip's feed and the measured forward/back shift (mm). */
  feedMmPerMin?: number
  shiftMm?: number
  source: { cellId: string; cellLabel: string; pickedAt: string }
}

export interface MachineReadingsLibrary {
  version: typeof MACHINE_READINGS_VERSION
  readings: MachineReading[]
}

export const emptyMachineReadings = (): MachineReadingsLibrary => ({
  version: MACHINE_READINGS_VERSION,
  readings: [],
})

/** What the user typed beside the pick: a line width (focus) or a shift (scan offset), in mm. */
export interface ReadingInput {
  lineWidthMm?: number | null
  shiftMm?: number | null
}

const sameMachine = (a: MachineReading['machine'], b: MachineReading['machine']) => a.name === b.name && a.frameId === b.frameId && a.moduleId === b.moduleId

export function readingFromCell(pattern: CalibrationPattern, cell: PatternCell, input: ReadingInput = {}, pickedAt = new Date()): MachineReading {
  if (!isReadingKind(pattern.kind) || !pattern.measures) throw new Error(`${pattern.title} is not a measurement pattern`)
  const m = pattern.machine
  const base = {
    id: `mr-${pickedAt.getTime().toString(36)}-${pattern.kind}-${cell.id}`,
    kind: pattern.kind,
    machine: {
      name: m.name,
      ...(m.frameId ? { frameId: m.frameId } : {}),
      ...(m.moduleId ? { moduleId: m.moduleId } : {}),
    },
    field: `${pattern.measures.on}.${pattern.measures.field}`,
    inContract: pattern.measures.inContract,
    materialId: pattern.material.id,
    source: {
      cellId: cell.id,
      cellLabel: cell.label,
      pickedAt: pickedAt.toISOString(),
    },
  }
  const pos = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined)
  switch (pattern.kind) {
    case 'firing-threshold':
      return { ...base, s: cell.settings.s, powerPct: cell.settings.powerPct }
    case 'focus-height': {
      const w = pos(input.lineWidthMm)
      return {
        ...base,
        zOffsetMm: Number(cell.extra?.zOffsetMm ?? 0),
        ...(w !== undefined ? { lineWidthMm: w } : {}),
      }
    }
    case 'scan-offset': {
      const shift = input.shiftMm
      if (typeof shift !== 'number' || !Number.isFinite(shift) || Math.abs(shift) > 5) throw new Error('Enter the measured shift in mm (−5 to 5)')
      return {
        ...base,
        feedMmPerMin: cell.settings.feedMmPerMin,
        shiftMm: shift,
      }
    }
  }
}

/**
 * Adds a reading, replacing the one it supersedes: the same kind on the same
 * machine (for scan offset, at the same feed).
 */
export function addReading(lib: MachineReadingsLibrary, r: MachineReading): MachineReadingsLibrary {
  const supersedes = (o: MachineReading) =>
    o.id === r.id || (o.kind === r.kind && sameMachine(o.machine, r.machine) && (r.kind !== 'scan-offset' || o.feedMmPerMin === r.feedMmPerMin))
  return {
    ...lib,
    readings: [...lib.readings.filter((o) => !supersedes(o)), r],
  }
}

export const removeReading = (lib: MachineReadingsLibrary, id: string): MachineReadingsLibrary => ({
  ...lib,
  readings: lib.readings.filter((r) => r.id !== id),
})

/** Readings of a kind for a machine, scan offsets by feed. */
export function readingsFor(lib: MachineReadingsLibrary, kind: ReadingKind, machine: MachineReading['machine']): MachineReading[] {
  return lib.readings.filter((r) => r.kind === kind && sameMachine(r.machine, machine)).sort((a, b) => (a.feedMmPerMin ?? 0) - (b.feedMmPerMin ?? 0))
}

/** The reading key of a profile: what a pattern generated for it records as `machine`. */
export const machineKey = (p: Pick<MachineProfile, 'name' | 'frameId' | 'moduleId'>): MachineReading['machine'] => ({
  name: p.name,
  ...(p.frameId ? { frameId: p.frameId } : {}),
  ...(p.moduleId ? { moduleId: p.moduleId } : {}),
})

/**
 * Readings of a kind for the machine a profile describes: those burned on it
 * by name; failing that, those burned on the same catalog frame and module
 * (a built-in that was copied on save keeps its frame and module, not its name).
 */
export function readingsForProfile(lib: MachineReadingsLibrary, kind: ReadingKind, profile: Pick<MachineProfile, 'name' | 'frameId' | 'moduleId'>): MachineReading[] {
  const exact = readingsFor(lib, kind, machineKey(profile))
  if (exact.length || !profile.frameId || !profile.moduleId) return exact
  const byFeed = new Map<number, MachineReading>()
  // Newest pick per feed when several machines on the same frame and module have readings.
  for (const r of lib.readings)
    if (r.kind === kind && r.machine.frameId === profile.frameId && r.machine.moduleId === profile.moduleId) {
      const f = r.feedMmPerMin ?? 0
      const o = byFeed.get(f)
      if (!o || o.source.pickedAt < r.source.pickedAt) byFeed.set(f, r)
    }
  return [...byFeed.values()].sort((a, b) => (a.feedMmPerMin ?? 0) - (b.feedMmPerMin ?? 0))
}

/**
 * Re-keys readings to the machine they were applied to. Applying to a built-in
 * saves a renamed copy; the readings follow it, so the copy still lists them.
 */
export function moveReadings(lib: MachineReadingsLibrary, ids: readonly string[], machine: MachineReading['machine']): MachineReadingsLibrary {
  const set = new Set(ids)
  return { ...lib, readings: lib.readings.map((r) => (set.has(r.id) ? { ...r, machine: { ...machine } } : r)) }
}

/**
 * The scan offset curve (contract ScanOffsetPoint[], sorted by feed) for a
 * machine's scan offset readings: one point per feed, offset = the measured
 * shift. Readings out of the contract's range are left out.
 */
export function scanOffsetFromReadings(readings: readonly MachineReading[]): ScanOffsetPoint[] {
  const byFeed = new Map<number, number>()
  for (const r of readings) {
    if (r.kind !== 'scan-offset' || !(typeof r.feedMmPerMin === 'number' && r.feedMmPerMin > 0) || typeof r.shiftMm !== 'number') continue
    if (!Number.isFinite(r.shiftMm) || Math.abs(r.shiftMm) > SCAN_OFFSET_MAX_MM) continue
    byFeed.set(r.feedMmPerMin, r.shiftMm)
  }
  return [...byFeed].sort(([a], [b]) => a - b).map(([feedMmPerMin, offsetMm]) => ({ feedMmPerMin, offsetMm }))
}

/** The applied curve as one line: "none", or "0.1 mm at 1000 · 0.3 mm at 6000 mm/min". */
export function describeScanOffset(curve: readonly ScanOffsetPoint[] | undefined): string {
  if (!curve?.length) return 'None: reverse lines land where they are programmed'
  return `${curve.map((p) => `${p.offsetMm} mm at ${p.feedMmPerMin}`).join(' · ')} mm/min`
}

/** One line for the UI. */
export function describeReading(r: MachineReading): string {
  switch (r.kind) {
    case 'firing-threshold':
      return `Marks from ${r.powerPct?.toFixed(1)}% (S${r.s})`
    case 'focus-height':
      return `Best focus at Z ${r.zOffsetMm! > 0 ? '+' : ''}${r.zOffsetMm} mm${r.lineWidthMm ? `, line ${r.lineWidthMm} mm wide` : ''}`
    case 'scan-offset':
      return `${r.shiftMm} mm at ${r.feedMmPerMin} mm/min`
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
const str = (v: unknown) => typeof v === 'string' && v.length > 0

/** Problems with a stored reading; empty means it loads. */
export function readingProblems(v: unknown): string[] {
  if (!isObject(v)) return ['not an object']
  const p: string[] = []
  for (const k of ['id', 'field', 'materialId']) if (!str(v[k])) p.push(`${k} missing`)
  if (!READING_KINDS.includes(v.kind as ReadingKind)) p.push('kind must be a measurement pattern')
  if (typeof v.inContract !== 'boolean') p.push('inContract must be true or false')
  if (!isObject(v.machine) || !str(v.machine.name)) p.push('machine.name missing')
  if (!isObject(v.source) || !str(v.source.cellId)) p.push('source missing')
  if (v.kind === 'firing-threshold' && !(num(v.s) && num(v.powerPct))) p.push('s and powerPct must be numbers')
  if (v.kind === 'focus-height' && !num(v.zOffsetMm)) p.push('zOffsetMm must be a number')
  if (v.kind === 'scan-offset' && !(num(v.feedMmPerMin) && num(v.shiftMm))) p.push('feedMmPerMin and shiftMm must be numbers')
  return p
}

/** The stored library, with invalid entries dropped and named in `warnings`. */
export function readMachineReadings(stored: unknown): {
  library: MachineReadingsLibrary
  warnings: string[]
} {
  const library = emptyMachineReadings()
  const warnings: string[] = []
  if (stored === undefined || stored === null) return { library, warnings }
  if (!isObject(stored) || !Array.isArray(stored.readings))
    return {
      library,
      warnings: ['machine readings were unreadable; starting empty'],
    }
  for (const r of stored.readings) {
    const problems = readingProblems(r)
    if (problems.length) warnings.push(`dropped machine reading (${problems[0]})`)
    else library.readings.push(r as MachineReading)
  }
  return { library, warnings }
}
