// SPDX-License-Identifier: GPL-3.0-or-later
// Persisted settings: the machine profile (a contract MachineProfile) and UI
// preferences. Stored with tauri-plugin-store in the app's config dir; in a
// plain browser (`pnpm dev` without Tauri) it falls back to localStorage.

import { isTauri } from '@tauri-apps/api/core'
import { MachineProfile, checkMachineProfile, validate, type MachineProfile as Machine } from 'aria-burn-core/contract'
import defaultMachine from 'aria-burn-core/profiles/provisional/machine-10w-diode.json'

export const SETTINGS_VERSION = 1
const STORE_FILE = 'settings.json'
const KEY = 'settings'

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
  network: NetworkSettings
  ui: UiPrefs
}

export function defaultSettings(): Settings {
  return {
    version: SETTINGS_VERSION,
    machine: structuredClone(defaultMachine) as Machine,
    network: { bindMode: 'localhost', port: 2323, pacing: 'realtime', listening: true },
    ui: { viewMode: 'color', verdictOverlay: false, relief: true, materialId: 'birch-ply-provisional' },
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * GRBL `$` settings the machine profile holds (COD-255): the emulator answers
 * `$$` with these and a sender's `$x=` writes change them.
 */
export const PROFILE_SETTINGS = {
  11: { label: 'Junction deviation', get: (m: Machine) => m.junctionDeviationMm, set: (m: Machine, v: number) => (m.junctionDeviationMm = v) },
  30: { label: 'Max S', get: (m: Machine) => m.sMax, set: (m: Machine, v: number) => (m.sMax = v) },
  32: { label: 'Laser mode', get: (m: Machine) => Number(m.laserMode), set: (m: Machine, v: number) => (m.laserMode = Math.trunc(v) !== 0) },
  110: { label: 'X max rate', get: (m: Machine) => m.maxRateMmPerMin.x, set: (m: Machine, v: number) => (m.maxRateMmPerMin.x = v) },
  111: { label: 'Y max rate', get: (m: Machine) => m.maxRateMmPerMin.y, set: (m: Machine, v: number) => (m.maxRateMmPerMin.y = v) },
  120: { label: 'X acceleration', get: (m: Machine) => m.accelMmPerS2.x, set: (m: Machine, v: number) => (m.accelMmPerS2.x = v) },
  121: { label: 'Y acceleration', get: (m: Machine) => m.accelMmPerS2.y, set: (m: Machine, v: number) => (m.accelMmPerS2.y = v) },
  130: { label: 'X max travel', get: (m: Machine) => m.travelMm.x, set: (m: Machine, v: number) => (m.travelMm.x = v) },
  131: { label: 'Y max travel', get: (m: Machine) => m.travelMm.y, set: (m: Machine, v: number) => (m.travelMm.y = v) },
} as const

export interface DumpResult {
  /** Settings applied, as `$n`. */
  applied: string[]
  /** Lines that looked like settings but were refused, with why. */
  rejected: string[]
}

/**
 * Applies a pasted `$$` dump from a real machine to the profile, in place.
 * Lines like `$110=6000.000 (x max rate, mm/min)` are read; settings the
 * profile doesn't hold ($0, $100…) and anything else are skipped.
 */
export function applySettingsDump(machine: Machine, dump: string): DumpResult {
  const result: DumpResult = { applied: [], rejected: [] }
  for (const line of dump.split(/\r?\n/)) {
    const match = line.trim().match(/^\$(\d+)\s*=\s*([-+]?[\d.]+)/)
    if (!match) continue
    const n = Number(match[1]) as keyof typeof PROFILE_SETTINGS
    const setting = PROFILE_SETTINGS[n]
    if (!setting) continue
    const v = Number(match[2])
    if (!Number.isFinite(v) || v < 0 || (n !== 32 && v === 0)) {
      result.rejected.push(`$${n}=${match[2]}: must be a positive number`)
      continue
    }
    setting.set(machine, v)
    result.applied.push(`$${n}`)
  }
  return result
}

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
    if (problems.length === 0) settings.machine = stored.machine as Machine
    else warnings.push(`stored machine profile is invalid (${problems[0]}); using the default`)
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

interface Backend {
  read(): Promise<unknown>
  write(value: Settings): Promise<void>
}

async function tauriBackend(): Promise<Backend> {
  const { load } = await import('@tauri-apps/plugin-store')
  const store = await load(STORE_FILE, { autoSave: false, defaults: {} })
  return {
    read: () => store.get(KEY),
    write: async (value) => {
      await store.set(KEY, value)
      await store.save()
    },
  }
}

const browserBackend: Backend = {
  read: async () => {
    try {
      const raw = localStorage.getItem(`aria-burn.${KEY}`)
      return raw ? JSON.parse(raw) : undefined
    } catch {
      return undefined
    }
  },
  write: async (value) => {
    try {
      localStorage.setItem(`aria-burn.${KEY}`, JSON.stringify(value))
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

export async function loadSettings(): Promise<{ settings: Settings; warnings: string[] }> {
  return mergeSettings(await (await getBackend()).read())
}

export async function saveSettings(settings: Settings): Promise<void> {
  const problems = machineProblems(settings.machine)
  if (problems.length) throw new Error(`machine profile invalid: ${problems.join('; ')}`)
  await (await getBackend()).write(plainCopy(settings))
}

/** Plain-object copy (Svelte state proxies don't survive structured clone or IPC). */
function plainCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}
