// SPDX-License-Identifier: GPL-3.0-or-later
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { ImportError, PROFILE_SETTINGS, applyLbdev, applySettingsDump, lbdevDevices, markUser } from './machine-import.ts'
import { defaultSettings, machineProblems } from './settings.ts'

const fixture = readFileSync(fileURLToPath(new URL('./fixtures/workshop-diode.lbdev', import.meta.url)), 'utf8')

describe('$$ import', () => {
  it('applies a pasted $$ dump to the profile and reports the settings it has no place for', () => {
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
      '<Idle|MPos:0.000,0.000,0.000|FS:0,0>',
      '[MSG:Pgm End]',
      'garbage line',
    ].join('\r\n')
    const r = applySettingsDump(m, dump)
    expect(r.applied.map((a) => a.split(' ')[0])).toEqual(['$11', '$30', '$32', '$110', '$111', '$120', '$121', '$130', '$131'])
    expect(r.ignored).toEqual(['$0=10: the simulator has no $0', '$100=80.000: the simulator has no $100', '“garbage line”: not a $ setting'])
    expect(r.rejected).toEqual([])
    expect(r.fields).toEqual(['junctionDeviationMm', 'sMax', 'laserMode', 'maxRateMmPerMin', 'accelMmPerS2', 'travelMm'])
    expect(m.junctionDeviationMm).toBe(0.02)
    expect(m.sMax).toBe(255)
    expect(m.laserMode).toBe(false)
    expect(m.maxRateMmPerMin).toEqual({ x: 6000, y: 5000 })
    expect(m.accelMmPerS2).toEqual({ x: 2500, y: 2000 })
    expect(m.travelMm).toEqual({ x: 400, y: 390 })
    expect(machineProblems(m)).toEqual([])
  })

  it('refuses values the profile cannot hold', () => {
    const m = defaultSettings().machine
    const r = applySettingsDump(m, '$30=0\n$110=-5\n$32=1')
    expect(r.applied).toEqual(['$32 Laser mode = 1'])
    expect(r.rejected).toHaveLength(2)
    expect(m.sMax).toBe(defaultSettings().machine.sMax)
  })

  it('maps every profile-backed setting both ways', () => {
    const m = defaultSettings().machine
    for (const [n, s] of Object.entries(PROFILE_SETTINGS)) {
      s.set(m, n === '32' ? 0 : 7)
      expect(s.get(m)).toBe(n === '32' ? 0 : 7)
    }
  })

  it('marks the changed fields as the user’s', () => {
    expect(markUser({ spot: 'provisional', sMax: 'sourced' }, ['sMax'])).toEqual({ spot: 'provisional', sMax: 'user' })
  })
})

describe('.lbdev import', () => {
  it('imports the fixture: bed size, S max and acceleration applied, every other field reported', () => {
    const m = defaultSettings().machine
    const before = structuredClone(m)
    const r = applyLbdev(m, fixture)
    expect(r.name).toBe('Workshop Diode 400')
    expect(r.devices).toEqual([
      { name: 'Workshop Diode 400', index: 0 },
      { name: 'Spare Gantry', index: 1 },
    ])
    expect(r.applied).toEqual([
      '$130 X max travel = 400',
      '$131 Y max travel = 380',
      '$30 Max S = 1000',
      '$120 X acceleration = 1500',
      '$121 Y acceleration = 1500',
      '$110 X max rate = 7200',
    ])
    expect(r.rejected).toEqual([])
    expect(r.ignored).toEqual([
      'Type=“TCP”: no simulator equivalent',
      'Address=“127.0.0.1”: no simulator equivalent',
      'Origin=“FrontLeft”: no simulator equivalent',
      'MirrorX=false: no simulator equivalent',
      'MirrorY=false: no simulator equivalent',
      'ProcessOffsetX=0: no simulator equivalent',
      'ProcessOffsetY=0: no simulator equivalent',
      'CameraLens=“none”: unknown field',
      'Settings.$100=80: the simulator has no $100',
      'Settings.FrameSpeed=3000: unknown field',
      'Settings.Units=“mm”: no simulator equivalent',
      'Settings.ToolChange={"Enabled":false}: unknown field',
      '1 other device(s) in the file: Spare Gantry',
    ])
    expect(r.fields).toEqual(['travelMm', 'sMax', 'accelMmPerS2', 'maxRateMmPerMin'])
    expect(m.travelMm).toEqual({ x: 400, y: 380 })
    expect(m.sMax).toBe(1000)
    expect(m.accelMmPerS2).toEqual({ x: 1500, y: 1500 })
    expect(m.maxRateMmPerMin).toEqual({ x: 7200, y: before.maxRateMmPerMin.y })
    // Fields the file doesn't carry are untouched.
    expect(m.spot).toEqual(before.spot)
    expect(m.opticalPowerW).toBe(before.opticalPowerW)
    expect(m.junctionDeviationMm).toBe(before.junctionDeviationMm)
    expect(machineProblems(m)).toEqual([])
  })

  it('imports another device of the file by index', () => {
    const m = defaultSettings().machine
    const r = applyLbdev(m, fixture, 1)
    expect(r.name).toBe('Spare Gantry')
    expect(m.travelMm).toEqual({ x: 300, y: 300 })
    expect(r.ignored).toContain('1 other device(s) in the file: Workshop Diode 400')
  })

  it('lists the devices of a file', () => {
    expect(lbdevDevices(fixture).map((d) => d.name)).toEqual(['Workshop Diode 400', 'Spare Gantry'])
  })

  it('refuses a file that is not a device file', () => {
    expect(() => applyLbdev(defaultSettings().machine, 'not json')).toThrow(ImportError)
    expect(() => applyLbdev(defaultSettings().machine, '{"Projects": []}')).toThrow(/no DeviceList/)
  })

  it('refuses bad values without changing the profile', () => {
    const m = defaultSettings().machine
    const r = applyLbdev(m, JSON.stringify({ DeviceList: [{ DisplayName: 'Bad', Width: 0, Height: 'tall' }] }))
    expect(r.applied).toEqual([])
    expect(r.rejected).toEqual(['Width (bed)=0: must be a positive number', 'Height (bed)=tall: must be a positive number'])
    expect(m).toEqual(defaultSettings().machine)
  })
})
