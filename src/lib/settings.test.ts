// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { SETTINGS_VERSION, defaultSettings, machineProblems, mergeSettings } from './settings.ts'

describe('settings', () => {
  it('ships a valid default machine profile', () => {
    expect(machineProblems(defaultSettings().machine)).toEqual([])
  })

  it('loads defaults when nothing is stored', () => {
    expect(mergeSettings(undefined)).toEqual({ settings: defaultSettings(), warnings: [] })
  })

  it('keeps stored values and fills in missing keys', () => {
    const machine = { ...defaultSettings().machine, opticalPowerW: 5.5 }
    const { settings, warnings } = mergeSettings({
      version: SETTINGS_VERSION,
      machine,
      network: { port: 8023 },
      ui: { viewMode: 'height', unknownKey: true },
    })
    expect(warnings).toEqual([])
    expect(settings.machine.opticalPowerW).toBe(5.5)
    expect(settings.network).toEqual({ ...defaultSettings().network, port: 8023 })
    expect(settings.ui.viewMode).toBe('height')
    expect(settings.ui).not.toHaveProperty('unknownKey')
  })

  it('ignores values of the wrong type', () => {
    const { settings } = mergeSettings({ version: SETTINGS_VERSION, network: { port: '23' }, ui: { relief: 'yes' } })
    expect(settings.network.port).toBe(defaultSettings().network.port)
    expect(settings.ui.relief).toBe(true)
  })

  it('falls back to the default machine when the stored one is invalid', () => {
    const bad = { ...defaultSettings().machine, opticalPowerW: -1 }
    const { settings, warnings } = mergeSettings({ version: SETTINGS_VERSION, machine: bad })
    expect(settings.machine).toEqual(defaultSettings().machine)
    expect(warnings[0]).toMatch(/machine profile is invalid/)
  })

  it('flags cross-field machine problems the schema cannot express', () => {
    const m = defaultSettings().machine
    expect(machineProblems({ ...m, spot: { ...m.spot, sigmaXMm: 0.01, sigmaYMm: 0.02 } })).toEqual([
      'spot.sigmaXMm must be the major axis (>= sigmaYMm)',
    ])
  })
})
