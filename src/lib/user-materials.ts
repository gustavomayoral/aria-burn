// SPDX-License-Identifier: GPL-3.0-or-later
// The user's calibrated materials (BURN-15): MaterialProfiles fitted from a
// photographed test grid, each with a pointer to its calibration record (the
// photo, G-code, machine profile and fit, saved as files in the app's data
// folder). Pure logic; persistence is in settings.ts (store key
// `userMaterials`).

import { MaterialProfile, checkMaterialProfile, validate, type MaterialProfile as Material } from 'aria-burn-core/contract'

export const USER_MATERIALS_VERSION = 1

export interface UserMaterial {
  profile: Material
  /** Calibration record id (folder under <app data>/calibrations). */
  calibrationId: string
  /** The machine the grid was burned on; the fit belongs to that laser. */
  machine: { name: string; frameId?: string; moduleId?: string }
  /** Starting profile the fit began from. */
  fromId: string
  createdAt: string
  /** Where the record's files went (desktop app), for the user to find them. */
  folder?: string
}

export interface UserMaterialsLibrary {
  version: typeof USER_MATERIALS_VERSION
  materials: UserMaterial[]
}

export const emptyUserMaterials = (): UserMaterialsLibrary => ({ version: USER_MATERIALS_VERSION, materials: [] })

/** A profile id slug from a name, unique against `taken`. */
export function materialId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'calibrated'
  let id = `${base}-calibrated`
  for (let i = 2; taken.includes(id); i++) id = `${base}-calibrated-${i}`
  return id
}

export const addUserMaterial = (lib: UserMaterialsLibrary, m: UserMaterial): UserMaterialsLibrary => ({
  ...lib,
  materials: [...lib.materials.filter((x) => x.profile.id !== m.profile.id), m],
})

export const removeUserMaterial = (lib: UserMaterialsLibrary, id: string): UserMaterialsLibrary => ({
  ...lib,
  materials: lib.materials.filter((x) => x.profile.id !== id),
})

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown) => typeof v === 'string' && v.length > 0

/** Problems with a stored calibrated material; empty means it loads. */
export function userMaterialProblems(v: unknown): string[] {
  if (!isObject(v)) return ['not an object']
  const p: string[] = []
  const issues = validate(MaterialProfile, v.profile)
  if (issues.length) p.push(`profile ${issues[0]!.path}: ${issues[0]!.message}`)
  else p.push(...checkMaterialProfile(v.profile as Material))
  for (const k of ['calibrationId', 'fromId', 'createdAt']) if (!str(v[k])) p.push(`${k} missing`)
  if (!isObject(v.machine) || !str(v.machine.name)) p.push('machine.name missing')
  return p
}

/** The stored library, with invalid entries dropped and named in `warnings`. */
export function readUserMaterials(stored: unknown): { library: UserMaterialsLibrary; warnings: string[] } {
  const library = emptyUserMaterials()
  const warnings: string[] = []
  if (stored === undefined || stored === null) return { library, warnings }
  if (!isObject(stored) || !Array.isArray(stored.materials)) return { library, warnings: ['calibrated materials were unreadable; starting empty'] }
  for (const m of stored.materials) {
    const problems = userMaterialProblems(m)
    const name = isObject(m) && isObject(m.profile) && str(m.profile.name) ? ` “${String(m.profile.name)}”` : ''
    if (problems.length) warnings.push(`dropped calibrated material${name} (${problems[0]})`)
    else library.materials.push(m as unknown as UserMaterial)
  }
  return { library, warnings }
}
