// SPDX-License-Identifier: GPL-3.0-or-later
// Machine library actions (BURN-31) on the app's state: load, pick from the
// catalog, new/update/rename/duplicate/delete, imports, Save, and `$x=` writes
// from a sender. Each action persists the library and the live profile, and
// pushes the live profile to the emulator, whose `$$` LightBurn reads.
//
// Written against a small host interface so the app (Svelte state) and the
// tests (a plain object over an in-memory store) run the same code.

import type { MachineProfile, ScanOffsetPoint } from 'aria-burn-core/contract'
import { applyLbdev, applySettingsDump, markUser, type ImportReport, type LbdevImport } from './machine-import.ts'
import {
  BUILTIN_DEFAULT_ID,
  catalogMachineId,
  changedFields,
  commitLive,
  createMachine,
  defaultMachineEntry,
  deleteMachine,
  duplicateMachine,
  findMachine,
  liveFieldStatus,
  renameMachine,
  uniqueName,
  updateMachine,
  type Machine,
  type MachineLibrary,
} from './machines.ts'
import { loadLibrary, loadSettings, machineProblems, saveLibrary, saveSettings, type Settings } from './settings.ts'

export interface MachineHost {
  settings: Settings
  library: MachineLibrary
  warnings: string[]
  /** Pushes the live profile (and network settings) to the emulator. */
  applyEmulator(): Promise<void>
}

/** Name of the machine a customised profile from before the library becomes (as Aria Studio). */
export const MIGRATED_MACHINE_NAME = 'My machine'

const plain = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Reads settings and library; a customised live profile with no library yet becomes “My machine”. */
export async function loadMachines(host: MachineHost): Promise<void> {
  const { settings, warnings } = await loadSettings()
  const lib = await loadLibrary()
  host.settings = settings
  host.library = lib.library
  host.warnings = [...warnings, ...lib.warnings]
  const fresh = lib.library.machines.length === 0 && lib.library.activeId === BUILTIN_DEFAULT_ID
  if (fresh && changedFields(defaultMachineEntry().profile, settings.machine).length > 0) {
    const { library } = createMachine(lib.library, MIGRATED_MACHINE_NAME, settings.machine, settings.machineStatus)
    host.library = library
    host.settings.machine.name = MIGRATED_MACHINE_NAME
    await persist(host)
  }
}

async function persist(host: MachineHost): Promise<void> {
  await saveLibrary(host.library)
  await saveSettings(host.settings)
}

export const activeMachine = (host: MachineHost): Machine | null => findMachine(host.library, host.library.activeId)

/** The live profile's field status, with edits since the last Load or Save marked as the user's. */
export const liveStatus = (host: MachineHost) => liveFieldStatus(activeMachine(host), host.settings.machine, host.settings.machineStatus)

/** Makes a built-in or user machine the live profile. Unsaved edits to the live profile are dropped. */
export async function loadMachine(host: MachineHost, id: string): Promise<Machine> {
  const machine = findMachine(host.library, id)
  if (!machine) throw new Error(`no machine ${id}`)
  host.settings.machine = plain(machine.profile)
  host.settings.machineStatus = { ...machine.fieldStatus }
  host.library = { ...host.library, activeId: id }
  await persist(host)
  await host.applyEmulator()
  return machine
}

/** Picker: a catalog frame with one of the modules it lists. */
export const pickCatalog = (host: MachineHost, frameId: string, moduleId: string) => loadMachine(host, catalogMachineId(frameId, moduleId))

/** New…: keeps the live profile as a user machine, which becomes active. */
export async function saveAsNew(host: MachineHost, name: string): Promise<Machine> {
  const { library, machine } = createMachine(host.library, name, host.settings.machine, liveStatus(host))
  host.library = library
  host.settings.machine = plain(machine.profile)
  host.settings.machineStatus = { ...machine.fieldStatus }
  await persist(host)
  await host.applyEmulator()
  return machine
}

/** Update: writes the live profile into the active user machine. */
export async function updateActive(host: MachineHost): Promise<void> {
  const id = host.library.activeId
  if (!id) throw new Error('no active machine')
  const status = liveStatus(host)
  host.library = updateMachine(host.library, id, host.settings.machine, status)
  host.settings.machineStatus = status
  await persist(host)
}

export async function rename(host: MachineHost, id: string, name: string): Promise<void> {
  host.library = renameMachine(host.library, id, name)
  if (host.library.activeId === id) host.settings.machine.name = name.trim()
  await persist(host)
  if (host.library.activeId === id) await host.applyEmulator()
}

/** Duplicate: copies a machine (built-in or the user's) and loads the copy. */
export async function duplicate(host: MachineHost, id: string): Promise<Machine> {
  const { library, machine } = duplicateMachine(host.library, id)
  host.library = library
  return loadMachine(host, machine.id)
}

/** Delete: the live profile stays as it is, with no active machine. */
export async function remove(host: MachineHost, id: string): Promise<void> {
  host.library = deleteMachine(host.library, id)
  await persist(host)
}

/**
 * The settings screen's Save: a user machine takes the edits; a built-in is
 * never changed, so edits to one go into a copy that becomes active.
 */
export async function saveSettingsScreen(host: MachineHost): Promise<Machine | null> {
  const status = liveStatus(host)
  const { library, copied } = commitLive(host.library, host.settings.machine, status)
  host.library = library
  host.settings.machineStatus = status
  if (copied) host.settings.machine.name = copied.name
  await persist(host)
  return copied
}

/**
 * Applies a scan offset curve (from the user's saved readings, BURN-48) to the
 * live profile and saves it as the settings screen's Save does: into the
 * active user machine, or into a copy of a built-in. The field becomes the
 * user's. An empty curve clears the offset. Returns the copy, if one was made.
 */
export async function applyScanOffset(host: MachineHost, curve: readonly ScanOffsetPoint[]): Promise<Machine | null> {
  const next = { ...plain(host.settings.machine), scanOffsetMm: curve.map((p) => ({ ...p })) }
  const problems = machineProblems(next)
  if (problems.length) throw new Error(problems[0])
  host.settings.machine = next
  const copy = await saveSettingsScreen(host)
  await host.applyEmulator()
  return copy
}

/** Pasted `$$` output: applied to the live profile, kept when the user saves. */
export function importDump(host: MachineHost, dump: string): ImportReport {
  const report = applySettingsDump(host.settings.machine, dump)
  host.settings.machineStatus = markUser(host.settings.machineStatus, report.fields)
  return report
}

/**
 * A LightBurn device file: its fields applied over the live profile, saved as
 * a new user machine named after the device, which becomes active. Nothing is
 * created when the file sets no field the simulator holds.
 */
export async function importLbdev(host: MachineHost, text: string, device = 0): Promise<{ report: LbdevImport; machine: Machine | null }> {
  const profile = plain(host.settings.machine)
  const report = applyLbdev(profile, text, device)
  if (report.fields.length === 0) return { report, machine: null }
  const problems = machineProblems(profile)
  if (problems.length) {
    report.rejected.push(...problems)
    return { report, machine: null }
  }
  const status = markUser(liveStatus(host), report.fields)
  const { library, machine } = createMachine(host.library, uniqueName(report.name ?? 'LightBurn device', host.library.machines), profile, status)
  host.library = library
  return { report, machine: await loadMachine(host, machine.id) }
}

/**
 * A sender's `$x=` write changed the emulated settings (COD-255): the live
 * profile takes them, and so does the active user machine. A built-in is never
 * written: the change goes into a copy that becomes active. Returns the copy, if any.
 */
export async function senderWrote(host: MachineHost, written: MachineProfile): Promise<Machine | null> {
  // A sender can't write the scan offset (it is no `$` setting), and the Rust
  // side drops an empty one when it serializes: keep the live profile's. The
  // overlay also keeps the live profile's key order, which the "edited" check compares.
  const { scanOffsetMm: _notWritable, ...rest } = written
  const profile: MachineProfile = { ...plain(host.settings.machine), ...rest }
  const problems = machineProblems(profile)
  if (problems.length) {
    host.warnings = [...host.warnings, `Ignored $ settings from the sender: ${problems[0]}`]
    return null
  }
  const fields = changedFields(host.settings.machine, profile)
  const status = markUser(liveStatus(host), fields)
  const { library, copied } = commitLive(host.library, profile, status)
  host.library = library
  host.settings.machine = plain(profile)
  host.settings.machineStatus = status
  if (copied) {
    host.settings.machine.name = copied.name
    host.warnings = [...host.warnings, `The sender changed ${fields.length ? fields.join(', ') : 'settings'} on a built-in machine; saved them as “${copied.name}”.`]
  }
  try {
    await persist(host)
  } catch (e) {
    host.warnings = [...host.warnings, `Couldn’t save the sender’s $ settings: ${String(e)}`]
  }
  // The emulator keeps running the written values; only the name changed with a copy.
  if (copied) await host.applyEmulator()
  return copied
}
