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
