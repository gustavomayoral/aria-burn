// SPDX-License-Identifier: GPL-3.0-or-later
// Machine imports (BURN-31): a pasted GRBL `$$` dump (moved here from the
// settings screen, COD-255) and LightBurn `.lbdev` device files. Each import
// changes only the fields its source carries and reports what it applied, what
// it ignored and what it refused. Nothing is dropped silently: an unknown
// `$` setting or device field is listed under `ignored`.

import type { MachineProfile, ProfileField } from 'aria-burn-core/contract'
import type { MachineFieldStatus } from './machines.ts'

type Setting = {
  label: string
  field: ProfileField
  get: (m: MachineProfile) => number
  set: (m: MachineProfile, v: number) => void
}

/**
 * GRBL `$` settings the machine profile holds (COD-255): the emulator answers
 * `$$` with these and a sender's `$x=` writes change them.
 */
export const PROFILE_SETTINGS: Record<number, Setting> = {
  11: { label: 'Junction deviation', field: 'junctionDeviationMm', get: (m) => m.junctionDeviationMm, set: (m, v) => (m.junctionDeviationMm = v) },
  30: { label: 'Max S', field: 'sMax', get: (m) => m.sMax, set: (m, v) => (m.sMax = v) },
  32: { label: 'Laser mode', field: 'laserMode', get: (m) => Number(m.laserMode), set: (m, v) => (m.laserMode = Math.trunc(v) !== 0) },
  110: { label: 'X max rate', field: 'maxRateMmPerMin', get: (m) => m.maxRateMmPerMin.x, set: (m, v) => (m.maxRateMmPerMin.x = v) },
  111: { label: 'Y max rate', field: 'maxRateMmPerMin', get: (m) => m.maxRateMmPerMin.y, set: (m, v) => (m.maxRateMmPerMin.y = v) },
  120: { label: 'X acceleration', field: 'accelMmPerS2', get: (m) => m.accelMmPerS2.x, set: (m, v) => (m.accelMmPerS2.x = v) },
  121: { label: 'Y acceleration', field: 'accelMmPerS2', get: (m) => m.accelMmPerS2.y, set: (m, v) => (m.accelMmPerS2.y = v) },
  130: { label: 'X max travel', field: 'travelMm', get: (m) => m.travelMm.x, set: (m, v) => (m.travelMm.x = v) },
  131: { label: 'Y max travel', field: 'travelMm', get: (m) => m.travelMm.y, set: (m, v) => (m.travelMm.y = v) },
}

export interface ImportReport {
  /** What was written into the profile, e.g. `$110 X max rate = 6000`. */
  applied: string[]
  /** Fields or settings the source carries that the profile has no place for, with why. */
  ignored: string[]
  /** Values for profile fields that were refused, with why. */
  rejected: string[]
  /** Profile fields that changed; the caller marks them as the user's. */
  fields: ProfileField[]
}

const emptyReport = (): ImportReport => ({ applied: [], ignored: [], rejected: [], fields: [] })

/** Sets one profile-backed `$` setting, or says why not. */
function applySetting(machine: MachineProfile, report: ImportReport, n: number, raw: string | number, from = `$${n}`): void {
  const setting = PROFILE_SETTINGS[n]
  if (!setting) {
    report.ignored.push(`${from}=${raw}: the simulator has no $${n}`)
    return
  }
  const v = Number(raw)
  if (!Number.isFinite(v) || v < 0 || (n !== 32 && v === 0)) {
    report.rejected.push(`${from}=${raw}: must be a positive number`)
    return
  }
  setting.set(machine, v)
  report.applied.push(`$${n} ${setting.label} = ${v}`)
  if (!report.fields.includes(setting.field)) report.fields.push(setting.field)
}

/**
 * Applies a pasted `$$` dump from a real machine to the profile, in place.
 * Lines like `$110=6000.000 (x max rate, mm/min)` are read. Settings the
 * profile doesn't hold ($0, $100…) are reported as ignored; GRBL's own
 * responses (`ok`, `<Idle|…>` status reports, `[MSG:…]`) are not settings and
 * are skipped; any other line is reported.
 */
export function applySettingsDump(machine: MachineProfile, dump: string): ImportReport {
  const report = emptyReport()
  for (const raw of dump.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line === 'ok' || /^<.*>$/.test(line) || /^\[.*\]$/.test(line)) continue
    const match = line.match(/^\$(\d+)\s*=\s*([^\s(]+)/)
    if (!match) {
      report.ignored.push(`“${line}”: not a $ setting`)
      continue
    }
    applySetting(machine, report, Number(match[1]), match[2]!)
  }
  return report
}

/** Marks the fields an import changed as the user's. */
export function markUser(status: MachineFieldStatus, fields: readonly ProfileField[]): MachineFieldStatus {
  const out = { ...status }
  for (const f of fields) out[f] = 'user'
  return out
}

// ---------------------------------------------------------------------------
// LightBurn device files (.lbdev)
//
// LightBurn exports devices as JSON: `{ "DeviceList": [ { … }, … ] }`. Each
// device carries `DisplayName`/`Name`, `Type`, the bed `Width` and `Height`
// (mm), and a `Settings` object of LightBurn's own options. LightBurn doesn't
// publish the format, so this importer maps only the fields whose meaning is
// clear and lists every other one under `ignored`:
//
// - `Width` / `Height` → the bed, as `$130` / `$131` max travel (LightBurn
//   checks its bed against these on GRBL machines).
// - In `Settings`, GRBL settings stored by number (`$110`, `110`) go through
//   the same mapping as a `$$` dump, and the S-value and acceleration options
//   in SETTING_ALIASES map to `$30` and `$120`/`$121`.
//
// Keys that are known but have no simulator equivalent (mirroring, offsets,
// the connection) are reported as ignored with that reason.

const SETTING_ALIASES: Record<string, number[]> = {
  maxsvalue: [30],
  smax: [30],
  svaluemax: [30],
  acceleration: [120, 121],
  accel: [120, 121],
  accelx: [120],
  accely: [121],
}

const NO_EQUIVALENT = new Set(
  ['Type', 'DeviceName', 'Port', 'BaudRate', 'Address', 'Origin', 'MirrorX', 'MirrorY', 'ProcessOffsetX', 'ProcessOffsetY', 'HomeOnStartup', 'AutoHome', 'Units'].map((k) =>
    k.toLowerCase(),
  ),
)

export interface LbdevDevice {
  name: string
  index: number
}

export interface LbdevImport extends ImportReport {
  /** The device's display name, for the new machine. */
  name: string | null
  /** Every device in the file. */
  devices: LbdevDevice[]
}

export class ImportError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const show = (v: unknown) => (typeof v === 'string' ? `“${v}”` : JSON.stringify(v))

function deviceList(text: string): Record<string, unknown>[] {
  let data: unknown
  try {
    data = JSON.parse(text.replace(/^﻿/, ''))
  } catch (e) {
    throw new ImportError(`Not a LightBurn device file: the file isn’t JSON (${e instanceof Error ? e.message : String(e)}).`)
  }
  const list = isObject(data) && Array.isArray(data.DeviceList) ? data.DeviceList : isObject(data) && ('Width' in data || 'Height' in data) ? [data] : null
  const devices = list?.filter(isObject) ?? []
  if (devices.length === 0) throw new ImportError('Not a LightBurn device file: no DeviceList with a device in it.')
  return devices
}

const deviceName = (d: Record<string, unknown>, i: number) =>
  typeof d.DisplayName === 'string' && d.DisplayName.trim() ? d.DisplayName.trim() : typeof d.Name === 'string' && d.Name.trim() ? d.Name.trim() : `Device ${i + 1}`

/** The devices in a `.lbdev` file, for a choice when there are several. */
export const lbdevDevices = (text: string): LbdevDevice[] => deviceList(text).map((d, index) => ({ name: deviceName(d, index), index }))

/**
 * Applies one device of a `.lbdev` file to the profile, in place. Throws
 * ImportError when the text isn't a device file at all.
 */
export function applyLbdev(machine: MachineProfile, text: string, index = 0): LbdevImport {
  const list = deviceList(text)
  const device = list[index]
  if (!device) throw new ImportError(`The file has no device ${index + 1}.`)
  const report: LbdevImport = { ...emptyReport(), name: deviceName(device, index), devices: list.map((d, i) => ({ name: deviceName(d, i), index: i })) }

  for (const [key, value] of Object.entries(device)) {
    const lower = key.toLowerCase()
    if (key === 'DisplayName' || key === 'Name') continue
    if (key === 'Width') applySetting(machine, report, 130, value as number, 'Width (bed)')
    else if (key === 'Height') applySetting(machine, report, 131, value as number, 'Height (bed)')
    else if (key === 'Settings' && isObject(value)) applyDeviceSettings(machine, report, value)
    else if (NO_EQUIVALENT.has(lower)) report.ignored.push(`${key}=${show(value)}: no simulator equivalent`)
    else report.ignored.push(`${key}=${show(value)}: unknown field`)
  }
  if (list.length > 1) report.ignored.push(`${list.length - 1} other device(s) in the file: ${list.filter((_, i) => i !== index).map(deviceName).join(', ')}`)
  return report
}

function applyDeviceSettings(machine: MachineProfile, report: ImportReport, settings: Record<string, unknown>) {
  for (const [key, value] of Object.entries(settings)) {
    const from = `Settings.${key}`
    const grbl = key.match(/^\$?(\d+)$/)
    const alias = SETTING_ALIASES[key.toLowerCase().replace(/[^a-z]/g, '')]
    const scalar = typeof value === 'number' || typeof value === 'string'
    if (grbl && scalar) applySetting(machine, report, Number(grbl[1]), value, from)
    else if (alias && scalar) for (const n of alias) applySetting(machine, report, n, value, from)
    else if (NO_EQUIVALENT.has(key.toLowerCase())) report.ignored.push(`${from}=${show(value)}: no simulator equivalent`)
    else report.ignored.push(`${from}=${show(value)}: unknown field`)
  }
}

/** One line per report section, for the settings screen. */
export function summarize(report: ImportReport): string[] {
  const out = [report.applied.length ? `Applied: ${report.applied.join('; ')}.` : 'Nothing applied: no fields the simulator holds.']
  if (report.rejected.length) out.push(`Refused: ${report.rejected.join('; ')}.`)
  if (report.ignored.length) out.push(`Ignored: ${report.ignored.join('; ')}.`)
  return out
}
