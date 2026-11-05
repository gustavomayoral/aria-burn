// SPDX-License-Identifier: GPL-3.0-or-later
// Machine picker and user machine library (BURN-31). Same flow as Aria
// Studio's Preferences → Machines (COD-151): read-only built-ins listed before
// the user's own machines, Load applies one, New keeps the settings being
// edited as a machine, Update writes them into the selected one. Built-ins are
// the Default profile and every catalog frame × module pair (BURN-30), and
// editing one saves a copy rather than changing it.
//
// The library is stored apart from the live profile (`Settings.machine`, the
// last applied one), as in Aria Studio, so a restart opens what was last used.

import {
  combineMachine,
  profileFieldStatus,
  PROFILE_FRAME_FIELDS,
  PROFILE_MODULE_FIELDS,
  type LaserModule,
  type MachineFrame,
  type MachineProfile,
  type ProfileField,
} from 'aria-burn-core/contract'
import { CATALOG_FRAMES, findFrame, findModule, modulesForFrame } from 'aria-burn-core/profiles/catalog/index.ts'
import defaultMachine from 'aria-burn-core/profiles/provisional/machine-10w-diode.json'

/** Where a profile value came from: the catalog's two statuses, or the user (edited, imported, written by a sender). */
export type FieldSource = 'sourced' | 'provisional' | 'user'
export type MachineFieldStatus = Partial<Record<ProfileField, FieldSource>>

export const PROFILE_FIELDS: readonly ProfileField[] = [...PROFILE_MODULE_FIELDS, ...PROFILE_FRAME_FIELDS]

export interface Machine {
  id: string
  name: string
  profile: MachineProfile
  fieldStatus: MachineFieldStatus
}

/** The user's machines and the one in use; built-ins are not stored. */
export interface MachineLibrary {
  /** A built-in or user machine id; null when the live profile is no saved machine. */
  activeId: string | null
  machines: Machine[]
}

export const BUILTIN_DEFAULT_ID = 'builtin-default'
/** User machines kept at most (as Aria Studio). */
export const MAX_MACHINES = 50
const CATALOG_PREFIX = 'catalog:'

export const catalogMachineId = (frameId: string, moduleId: string) => `${CATALOG_PREFIX}${frameId}+${moduleId}`

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

function allStatus(source: FieldSource): MachineFieldStatus {
  return Object.fromEntries(PROFILE_FIELDS.map((k) => [k, source]))
}

export function defaultMachineEntry(): Machine {
  // The default profile is provisional throughout (aria-burn-core SOURCES.md).
  return { id: BUILTIN_DEFAULT_ID, name: 'Default (10 W diode)', profile: plain(defaultMachine) as MachineProfile, fieldStatus: allStatus('provisional') }
}

export function catalogMachine(frame: MachineFrame, module: LaserModule): Machine {
  const profile = combineMachine(frame, module)
  return { id: catalogMachineId(frame.id, module.id), name: profile.name, profile, fieldStatus: profileFieldStatus(frame, module) }
}

/**
 * A built-in by id: Default, or a catalog frame with one of the modules it
 * lists. A module the frame doesn't list is not a built-in.
 */
export function builtinMachine(id: string | null): Machine | null {
  if (id === BUILTIN_DEFAULT_ID) return defaultMachineEntry()
  if (!id?.startsWith(CATALOG_PREFIX)) return null
  const [frameId, moduleId] = id.slice(CATALOG_PREFIX.length).split('+')
  const frame = findFrame(frameId ?? '')
  if (!frame || !moduleId || !frame.modules.includes(moduleId)) return null
  const module = findModule(moduleId)
  return module ? catalogMachine(frame, module) : null
}

export const isBuiltin = (id: string | null) => builtinMachine(id) !== null

export function findMachine(library: MachineLibrary, id: string | null): Machine | null {
  return builtinMachine(id) ?? library.machines.find((m) => m.id === id) ?? null
}

/** Catalog frames grouped by brand, for the picker. */
export function catalogByBrand(): { brand: string; frames: MachineFrame[] }[] {
  const groups = new Map<string, MachineFrame[]>()
  for (const f of CATALOG_FRAMES) groups.set(f.brand, [...(groups.get(f.brand) ?? []), f])
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([brand, frames]) => ({ brand, frames }))
}

export { modulesForFrame }

/** Why `name` can't name a user machine, or null. `exceptId` is the machine being renamed. */
export function machineNameError(name: string, machines: readonly Machine[], exceptId?: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'Enter a name.'
  if (machines.some((m) => m.id !== exceptId && m.name === trimmed)) return 'A machine already has that name.'
  return null
}

/** `base`, or `base 2`, `base 3`… whichever no user machine has. */
export function uniqueName(base: string, machines: readonly Machine[]): string {
  if (!machines.some((m) => m.name === base)) return base
  for (let i = 2; ; i++) if (!machines.some((m) => m.name === `${base} ${i}`)) return `${base} ${i}`
}

const newId = () => `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`

export class LibraryError extends Error {}

function assertRoom(library: MachineLibrary) {
  if (library.machines.length >= MAX_MACHINES) throw new LibraryError(`At most ${MAX_MACHINES} machines.`)
}

/** Adds a user machine and makes it active; returns the new library and the machine. */
export function createMachine(library: MachineLibrary, name: string, profile: MachineProfile, fieldStatus: MachineFieldStatus): { library: MachineLibrary; machine: Machine } {
  assertRoom(library)
  const error = machineNameError(name, library.machines)
  if (error) throw new LibraryError(error)
  const machine: Machine = { id: newId(), name: name.trim(), profile: { ...plain(profile), name: name.trim() }, fieldStatus: { ...fieldStatus } }
  return { library: { activeId: machine.id, machines: [...library.machines, machine] }, machine }
}

export function renameMachine(library: MachineLibrary, id: string, name: string): MachineLibrary {
  if (isBuiltin(id)) throw new LibraryError('Built-in machines can’t be renamed; duplicate one first.')
  const error = machineNameError(name, library.machines, id)
  if (error) throw new LibraryError(error)
  const trimmed = name.trim()
  return { ...library, machines: library.machines.map((m) => (m.id === id ? { ...m, name: trimmed, profile: { ...m.profile, name: trimmed } } : m)) }
}

/** Copies a built-in or user machine as `<name> copy`; the copy becomes active. */
export function duplicateMachine(library: MachineLibrary, id: string): { library: MachineLibrary; machine: Machine } {
  const source = findMachine(library, id)
  if (!source) throw new LibraryError('No such machine.')
  return createMachine(library, uniqueName(`${source.name} copy`, library.machines), source.profile, source.fieldStatus)
}

export function deleteMachine(library: MachineLibrary, id: string): MachineLibrary {
  if (isBuiltin(id)) throw new LibraryError('Built-in machines can’t be deleted.')
  return { activeId: library.activeId === id ? null : library.activeId, machines: library.machines.filter((m) => m.id !== id) }
}

/** Writes `profile` into a user machine (Update). */
export function updateMachine(library: MachineLibrary, id: string, profile: MachineProfile, fieldStatus: MachineFieldStatus): MachineLibrary {
  if (isBuiltin(id)) throw new LibraryError('Built-in machines are read-only.')
  return {
    ...library,
    machines: library.machines.map((m) => (m.id === id ? { ...m, profile: { ...plain(profile), name: m.name }, fieldStatus: { ...fieldStatus } } : m)),
  }
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/** Profile fields whose values differ between `a` and `b`. */
export function changedFields(a: MachineProfile, b: MachineProfile): ProfileField[] {
  return PROFILE_FIELDS.filter((k) => !same(a[k], b[k]))
}

/** The live profile's field status: the active machine's, with every field that differs from it marked `user`. */
export function liveFieldStatus(active: Machine | null, live: MachineProfile, stored: MachineFieldStatus): MachineFieldStatus {
  const status = { ...stored }
  if (active) for (const k of changedFields(active.profile, live)) status[k] = 'user'
  return status
}

export interface Commit {
  library: MachineLibrary
  /** Set when the change went into a new copy instead of the active machine. */
  copied: Machine | null
}

/**
 * Keeps the live profile in the library (the settings screen's Save, and a
 * sender's `$x=` write): a user machine is updated in place; a changed
 * built-in is never touched, and the change goes into a new copy that becomes
 * active. An unchanged built-in, or no active machine, leaves the library as is.
 */
export function commitLive(library: MachineLibrary, live: MachineProfile, status: MachineFieldStatus, copySuffix = 'copy'): Commit {
  const active = findMachine(library, library.activeId)
  if (!active) return { library, copied: null }
  if (!isBuiltin(active.id)) return { library: updateMachine(library, active.id, live, status), copied: null }
  if (changedFields(active.profile, live).length === 0) return { library, copied: null }
  const { library: next, machine } = createMachine(library, uniqueName(`${active.name} ${copySuffix}`, library.machines), live, status)
  return { library: next, copied: machine }
}

export const emptyLibrary = (): MachineLibrary => ({ activeId: BUILTIN_DEFAULT_ID, machines: [] })

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const SOURCES: readonly string[] = ['sourced', 'provisional', 'user']

/**
 * The stored library, cleaned: entries whose profile fails `isValid`, without a
 * name, with a built-in's id or a name already taken are dropped (and named in
 * `warnings`), at most {@link MAX_MACHINES}. An unknown active id falls back to null.
 */
export function readLibrary(raw: unknown, isValid: (profile: unknown) => string[]): { library: MachineLibrary; warnings: string[] } {
  if (raw === undefined || raw === null) return { library: emptyLibrary(), warnings: [] }
  if (!isObject(raw)) return { library: emptyLibrary(), warnings: ['machine library was not an object; starting empty'] }
  const warnings: string[] = []
  const machines: Machine[] = []
  for (const entry of Array.isArray(raw.machines) ? raw.machines : []) {
    if (machines.length >= MAX_MACHINES) {
      warnings.push(`more than ${MAX_MACHINES} machines stored; the rest were dropped`)
      break
    }
    if (!isObject(entry) || typeof entry.name !== 'string' || typeof entry.id !== 'string' || entry.id === '') {
      warnings.push('dropped a stored machine without an id or name')
      continue
    }
    const label = `stored machine “${entry.name}”`
    if (isBuiltin(entry.id) || machines.some((m) => m.id === entry.id) || machineNameError(entry.name, machines) !== null) {
      warnings.push(`dropped ${label}: its id or name is taken`)
      continue
    }
    const problems = isValid(entry.profile)
    if (problems.length) {
      warnings.push(`dropped ${label}: ${problems[0]}`)
      continue
    }
    const fieldStatus: MachineFieldStatus = {}
    if (isObject(entry.fieldStatus))
      for (const k of PROFILE_FIELDS) {
        const s = entry.fieldStatus[k]
        if (typeof s === 'string' && SOURCES.includes(s)) fieldStatus[k] = s as FieldSource
      }
    machines.push({ id: entry.id, name: entry.name.trim(), profile: entry.profile as MachineProfile, fieldStatus })
  }
  const library: MachineLibrary = { activeId: null, machines }
  const activeId = typeof raw.activeId === 'string' ? raw.activeId : null
  library.activeId = findMachine(library, activeId) ? activeId : null
  return { library, warnings }
}

/** Fields the user should treat with care: provisional in the catalog and not since replaced. */
export const provisionalFieldsOf = (status: MachineFieldStatus): ProfileField[] => PROFILE_FIELDS.filter((k) => status[k] === 'provisional')

/** Display labels and GRBL numbers of the profile fields, for badges and import reports. */
export const FIELD_LABELS: Record<ProfileField, string> = {
  opticalPowerW: 'Optical power',
  wavelengthNm: 'Wavelength',
  spot: 'Spot size',
  powerCurve: 'Power curve',
  sMax: 'Max S ($30)',
  laserMode: 'Laser mode ($32)',
  junctionDeviationMm: 'Junction deviation ($11)',
  maxRateMmPerMin: 'Max rate ($110/$111)',
  accelMmPerS2: 'Acceleration ($120/$121)',
  travelMm: 'Travel ($130/$131)',
  scanOffsetMm: 'Scan offset',
}
