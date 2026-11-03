// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest'
import { PROFILE_SETTINGS, SETTINGS_VERSION, applySettingsDump, defaultSettings, machineProblems, mergeSettings } from './settings.ts'

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

  it('applies a pasted $$ dump to the profile', () => {
    const m = defaultSettings().machine
    const dump = [
      'ok',
      '$0=10',
      '$11=0.020',
      '$30=255',
      '$32=0',
      '$100=80.000',
      '$110=6000.000 (x max rate, mm/min)',
      '$111=5000.000',
      '$120=2500.000',
      '$121=2000.000',
      '$130=400.000',
      '$131=390.000',
      '$122=-1',
      '<Idle|MPos:0.000,0.000,0.000|FS:0,0>',
    ].join('\r\n')
    const result = applySettingsDump(m, dump)
    expect(result).toEqual({ applied: ['$11', '$30', '$32', '$110', '$111', '$120', '$121', '$130', '$131'], rejected: [] })
    expect(m.junctionDeviationMm).toBe(0.02)
    expect(m.sMax).toBe(255)
    expect(m.laserMode).toBe(false)
    expect(m.maxRateMmPerMin).toEqual({ x: 6000, y: 5000 })
    expect(m.accelMmPerS2).toEqual({ x: 2500, y: 2000 })
    expect(m.travelMm).toEqual({ x: 400, y: 390 })
    expect(machineProblems(m)).toEqual([])
  })

  it('refuses dump values the profile cannot hold', () => {
    const m = defaultSettings().machine
    const result = applySettingsDump(m, '$30=0\n$110=-5\n$32=1')
    expect(result.applied).toEqual(['$32'])
    expect(result.rejected).toHaveLength(2)
    expect(m.sMax).toBe(defaultSettings().machine.sMax)
  })

  it('maps every profile-backed setting both ways', () => {
    const m = defaultSettings().machine
    for (const [n, s] of Object.entries(PROFILE_SETTINGS)) {
      s.set(m, n === '32' ? 0 : 7)
      expect(s.get(m)).toBe(n === '32' ? 0 : 7)
    }
  })
})
