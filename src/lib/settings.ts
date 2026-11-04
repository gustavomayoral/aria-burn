// SPDX-License-Identifier: GPL-3.0-or-later
// Persisted settings: the live machine profile (a contract MachineProfile, the
// last one applied) with its field status, UI preferences, and the user's
// machine library (BURN-31, stored under its own key as in Aria Studio).
// Stored with tauri-plugin-store in the app's config dir; in a plain browser
// (`pnpm dev` without Tauri) it falls back to localStorage.

import { isTauri } from '@tauri-apps/api/core'
import { MachineProfile, checkMachineProfile, validate, type MachineProfile as Machine } from 'aria-burn-core/contract'
import { readMaterialSettings, settingProblems, type MaterialSettingsLibrary } from './material-settings.ts'
import { PROFILE_FIELDS, defaultMachineEntry, readLibrary, type FieldSource, type MachineFieldStatus, type MachineLibrary } from './machines.ts'

export const SETTINGS_VERSION = 1
const STORE_FILE = 'settings.json'
const KEY = 'settings'
const LIBRARY_KEY = 'machines'
const MATERIAL_SETTINGS_KEY = 'materialSettings'

export type ViewMode = 'color' | 'height'

export interface NetworkSettings {
  bindMode: 'localhost' | 'lan'
  port: number
  pacing: 'realtime' | 'instant'
  listening: boolean
}

export interface UiPrefs {
  viewMode: ViewMode
  verdictOverlay: boolean
  relief: boolean
  materialId: string
}

export interface Settings {
  version: typeof SETTINGS_VERSION
  machine: Machine
  /** Where each live profile value came from (BURN-31); provisional ones are marked in the UI. */
  machineStatus: MachineFieldStatus
  network: NetworkSettings
  ui: UiPrefs
}

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    machine: defaultMachineEntry().profile,
    machineStatus: defaultMachineEntry().fieldStatus,
    network: { bindMode: 'localhost', port: 2323, pacing: 'realtime', listening: true },
    ui: { viewMode: 'color', verdictOverlay: false, relief: true, materialId: 'birch-ply-provisional' },
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Problems with a machine profile: schema first, then the cross-field rules. */
export function machineProblems(machine: unknown): string[] {
  const issues = validate(MachineProfile, machine).map((i) => `${i.path}: ${i.message}`)
  return issues.length ? issues : checkMachineProfile(machine as Machine)
}

/**
 * Merges stored settings over the defaults, field by field, so a settings file
 * from an older build (missing keys) or a hand-edited one still loads. An
 * invalid machine profile is dropped in favour of the default.
 */
export function mergeSettings(stored: unknown): { settings: Settings; warnings: string[] } {
  const settings = defaultSettings()
  const warnings: string[] = []
  if (!isObject(stored)) return { settings, warnings: stored === undefined || stored === null ? [] : ['settings were not an object; using defaults'] }
  if (stored.version !== SETTINGS_VERSION) warnings.push(`settings version ${String(stored.version)}; migrating to ${SETTINGS_VERSION}`)

  if (stored.machine !== undefined) {
    const problems = machineProblems(stored.machine)
    if (problems.length === 0) {
      settings.machine = stored.machine as Machine
      // A profile from before BURN-31 has no status: nothing is known about where it came from.
      settings.machineStatus = {}
    } else warnings.push(`stored machine profile is invalid (${problems[0]}); using the default`)
  }
  if (isObject(stored.machineStatus) && settings.machine === stored.machine) {
    const status: MachineFieldStatus = {}
    for (const k of PROFILE_FIELDS) {
      const v = stored.machineStatus[k]
      if (v === 'sourced' || v === 'provisional' || v === 'user') status[k] = v as FieldSource
    }
    settings.machineStatus = status
  }
  for (const section of ['network', 'ui'] as const) {
    const value = stored[section]
    if (!isObject(value)) continue
    const target = settings[section] as unknown as Record<string, unknown>
    for (const [k, v] of Object.entries(value)) {
      if (k in target && typeof v === typeof target[k]) target[k] = v
    }
  }
  return { settings, warnings }
}

export interface Backend {
  read(key: string): Promise<unknown>
  write(key: string, value: unknown): Promise<void>
}

async function tauriBackend(): Promise<Backend> {
  const { load } = await import('@tauri-apps/plugin-store')
  const store = await load(STORE_FILE, { autoSave: false, defaults: {} })
  return {
    read: (key) => store.get(key),
    write: async (key, value) => {
      await store.set(key, value)
      await store.save()
    },
  }
}

const browserBackend: Backend = {
  read: async (key) => {
    try {
      const raw = localStorage.getItem(`aria-burn.${key}`)
      return raw ? JSON.parse(raw) : undefined
    } catch {
      return undefined
    }
  },
  write: async (key, value) => {
    try {
      localStorage.setItem(`aria-burn.${key}`, JSON.stringify(value))
    } catch {
      // Private window or blocked storage: settings last for this session only.
    }
  },
}

let backend: Promise<Backend> | null = null
const getBackend = () => {
  backend ??= isTauri() ? tauriBackend() : Promise.resolve(browserBackend)
  return backend
}

/** Swaps the storage backend (tests stand in for the store file across a restart). */
export function useBackend(b: Backend | null): void {
  backend = b ? Promise.resolve(b) : null
}

export async function loadSettings(): Promise<{ settings: Settings; warnings: string[] }> {
  return mergeSettings(await (await getBackend()).read(KEY))
}

/** The user's machine library; invalid stored machines are dropped and named in `warnings`. */
export async function loadLibrary(): Promise<{ library: MachineLibrary; warnings: string[] }> {
  return readLibrary(await (await getBackend()).read(LIBRARY_KEY), machineProblems)
}

export async function saveLibrary(library: MachineLibrary): Promise<void> {
  for (const m of library.machines) {
    const problems = machineProblems(m.profile)
    if (problems.length) throw new Error(`machine “${m.name}” invalid: ${problems.join('; ')}`)
  }
  await (await getBackend()).write(LIBRARY_KEY, plainCopy(library))
}

/** Named material settings picked from calibration patterns (BURN-32). */
export async function loadMaterialSettings(): Promise<{ library: MaterialSettingsLibrary; warnings: string[] }> {
  return readMaterialSettings(await (await getBackend()).read(MATERIAL_SETTINGS_KEY))
}

export async function saveMaterialSettings(library: MaterialSettingsLibrary): Promise<void> {
  for (const s of library.settings) {
    const problems = settingProblems(s)
    if (problems.length) throw new Error(`material setting “${s.name}” invalid: ${problems.join('; ')}`)
  }
  await (await getBackend()).write(MATERIAL_SETTINGS_KEY, plainCopy(library))
}

export async function saveSettings(settings: Settings): Promise<void> {
  const problems = machineProblems(settings.machine)
  if (problems.length) throw new Error(`machine profile invalid: ${problems.join('; ')}`)
  await (await getBackend()).write(KEY, plainCopy(settings))
}

/** Plain-object copy (Svelte state proxies don't survive structured clone or IPC). */
function plainCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
